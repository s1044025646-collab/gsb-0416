import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { Mulberry32 } from "./rng";
import { Reservoir, Slot, StepExplanation } from "./reservoir";

/** 资源上限（可通过构造参数覆盖，便于测试）。 */
export interface Limits {
  maxCapacity: number;
  maxPayloadBytes: number;
  maxBatchRecords: number;
  maxTotalRecords: number;
  logRetention: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxCapacity: 10_000,
  maxPayloadBytes: 16 * 1024,
  maxBatchRecords: 1_000,
  // 位置 n 需要映射到 [0, n)，限制在 32 位随机整数范围内
  maxTotalRecords: 0xffffffff,
  logRetention: 1_000,
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface SamplerInfo {
  id: string;
  k: number;
  count: number;
  createdAt: string;
}

export interface AppendResult {
  samplerId: string;
  batchId: string;
  processed: number;
  totalCount: number;
  steps: StepExplanation[];
  idempotentReplay: boolean;
}

export interface ExportedState {
  id: string;
  k: number;
  count: number;
  rngState: number;
  slots: (Slot | null)[];
}

export class Store {
  private readonly db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath: string, limits: Partial<Limits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samplers (
        id TEXT PRIMARY KEY,
        k INTEGER NOT NULL,
        count INTEGER NOT NULL,
        rng_state INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slots (
        sampler_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (sampler_id, slot)
      );
      CREATE TABLE IF NOT EXISTS batches (
        sampler_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        records_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (sampler_id, batch_id)
      );
      CREATE TABLE IF NOT EXISTS log (
        sampler_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (sampler_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private newId(): string {
    return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }

  createSampler(k: number, seed?: number): SamplerInfo {
    if (!Number.isInteger(k) || k < 1 || k > this.limits.maxCapacity) {
      throw new ApiError("INVALID_CAPACITY", `容量 k 必须是 [1, ${this.limits.maxCapacity}] 内的整数`);
    }
    if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new ApiError("INVALID_SEED", "seed 必须是 [0, 2^32) 内的整数");
    }
    const actualSeed = seed ?? Math.floor(Math.random() * 0x100000000);
    const id = this.newId();
    const rng = new Mulberry32(actualSeed);
    this.db
      .prepare("INSERT INTO samplers (id, k, count, rng_state, created_at) VALUES (?, ?, 0, ?, ?)")
      .run(id, k, rng.getState() as number, new Date().toISOString());
    return { id, k, count: 0, createdAt: new Date().toISOString() };
  }

  private getSamplerRow(id: string): { id: string; k: number; count: number; rng_state: number } {
    const row = this.db.prepare("SELECT * FROM samplers WHERE id = ?").get(id) as
      | { id: string; k: number; count: number; rng_state: number }
      | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `抽样器不存在: ${id}`, 404);
    return row;
  }

  getInfo(id: string): SamplerInfo {
    const row = this.db.prepare("SELECT * FROM samplers WHERE id = ?").get(id) as
      | { id: string; k: number; count: number; created_at: string }
      | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `抽样器不存在: ${id}`, 404);
    return { id: row.id, k: row.k, count: row.count, createdAt: row.created_at };
  }

  /** 校验整批记录（在任何状态修改之前调用）。 */
  private validateBatch(samplerId: string, batchId: unknown, records: unknown): string[] {
    if (typeof batchId !== "string" || batchId.length === 0 || batchId.length > 200) {
      throw new ApiError("INVALID_BATCH_ID", "batchId 必须是 1-200 字符的字符串");
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new ApiError("EMPTY_BATCH", "records 必须是非空数组");
    }
    if (records.length > this.limits.maxBatchRecords) {
      throw new ApiError("BATCH_TOO_LARGE", `单批最多 ${this.limits.maxBatchRecords} 条`);
    }
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (typeof r !== "string") {
        throw new ApiError("INVALID_PAYLOAD", `第 ${i + 1} 条载荷必须是字符串`);
      }
      if (Buffer.byteLength(r, "utf8") > this.limits.maxPayloadBytes) {
        throw new ApiError("PAYLOAD_TOO_LARGE", `第 ${i + 1} 条载荷超过 ${this.limits.maxPayloadBytes} 字节`);
      }
    }
    const row = this.getSamplerRow(samplerId);
    if (row.count + records.length > this.limits.maxTotalRecords) {
      throw new ApiError("COUNT_LIMIT_EXCEEDED", `总记录数不能超过 ${this.limits.maxTotalRecords}`);
    }
    return records as string[];
  }

  /**
   * 批量追加。幂等：相同 batchId + 相同内容返回原结果；
   * 相同 batchId + 不同内容报 409。整批校验通过后在一个事务中原子更新。
   */
  appendBatch(samplerId: string, batchId: unknown, records: unknown): AppendResult {
    const payloads = this.validateBatch(samplerId, batchId, records);
    const bid = batchId as string;

    const existing = this.db
      .prepare("SELECT records_json, response_json FROM batches WHERE sampler_id = ? AND batch_id = ?")
      .get(samplerId, bid) as { records_json: string; response_json: string } | undefined;
    if (existing) {
      if (existing.records_json !== JSON.stringify(payloads)) {
        throw new ApiError("BATCH_CONFLICT", `批次编号 ${bid} 已存在但内容不同`, 409);
      }
      const replay = JSON.parse(existing.response_json) as AppendResult;
      return { ...replay, idempotentReplay: true };
    }

    const row = this.getSamplerRow(samplerId);
    const rng = Mulberry32.fromState(row.rng_state);
    const slots = this.loadSlots(samplerId, row.k);
    const reservoir = new Reservoir(row.k, rng, row.count, slots);

    const steps: StepExplanation[] = [];
    this.db.exec("BEGIN");
    try {
      for (const payload of payloads) {
        steps.push(reservoir.offer(payload));
      }
      const updateSampler = this.db.prepare("UPDATE samplers SET count = ?, rng_state = ? WHERE id = ?");
      updateSampler.run(reservoir.processedCount, rng.getState() as number, samplerId);

      const upsertSlot = this.db.prepare(
        "INSERT INTO slots (sampler_id, slot, position, payload) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (sampler_id, slot) DO UPDATE SET position = excluded.position, payload = excluded.payload",
      );
      const deleteSlot = this.db.prepare("DELETE FROM slots WHERE sampler_id = ? AND slot = ?");
      reservoir.getSlots().forEach((slot, i) => {
        if (slot) upsertSlot.run(samplerId, i, slot.position, slot.payload);
        else deleteSlot.run(samplerId, i);
      });

      const insertLog = this.db.prepare("INSERT INTO log (sampler_id, seq, entry_json) VALUES (?, ?, ?)");
      for (const step of steps) {
        insertLog.run(samplerId, step.position, JSON.stringify(step));
      }
      // 日志保留上限：只保留最近 logRetention 条，防止无限增长
      this.db
        .prepare(
          "DELETE FROM log WHERE sampler_id = ? AND seq <= (SELECT MAX(seq) FROM log WHERE sampler_id = ?) - ?",
        )
        .run(samplerId, samplerId, this.limits.logRetention);

      const result: AppendResult = {
        samplerId,
        batchId: bid,
        processed: steps.length,
        totalCount: reservoir.processedCount,
        steps,
        idempotentReplay: false,
      };
      this.db
        .prepare("INSERT INTO batches (sampler_id, batch_id, records_json, response_json) VALUES (?, ?, ?, ?)")
        .run(samplerId, bid, JSON.stringify(payloads), JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private loadSlots(samplerId: string, k: number): (Slot | null)[] {
    const slots: (Slot | null)[] = new Array(k).fill(null);
    const rows = this.db
      .prepare("SELECT slot, position, payload FROM slots WHERE sampler_id = ?")
      .all(samplerId) as { slot: number; position: number; payload: string }[];
    for (const r of rows) slots[r.slot] = { position: r.position, payload: r.payload };
    return slots;
  }

  /** 查询样本。sort=slot 按槽序（内部真实顺序），sort=position 仅展示排序。 */
  getSample(samplerId: string, sort: "slot" | "position" = "slot"): { k: number; count: number; sample: { slot: number; position: number; payload: string }[] } {
    const row = this.getSamplerRow(samplerId);
    const rows = this.db
      .prepare("SELECT slot, position, payload FROM slots WHERE sampler_id = ? ORDER BY slot")
      .all(samplerId) as { slot: number; position: number; payload: string }[];
    const sample = rows.map((r) => ({ slot: r.slot, position: r.position, payload: r.payload }));
    if (sort === "position") sample.sort((a, b) => a.position - b.position);
    return { k: row.k, count: row.count, sample };
  }

  getLog(samplerId: string, limit = 50): StepExplanation[] {
    this.getSamplerRow(samplerId);
    const cap = Math.min(Math.max(1, limit), this.limits.logRetention);
    const rows = this.db
      .prepare("SELECT entry_json FROM log WHERE sampler_id = ? ORDER BY seq DESC LIMIT ?")
      .all(samplerId, cap) as { entry_json: string }[];
    return rows.map((r) => JSON.parse(r.entry_json) as StepExplanation).reverse();
  }

  exportState(samplerId: string): ExportedState {
    const row = this.getSamplerRow(samplerId);
    return {
      id: row.id,
      k: row.k,
      count: row.count,
      rngState: row.rng_state,
      slots: this.loadSlots(samplerId, row.k),
    };
  }

  /** 从导出状态创建一个新抽样器（新 id，状态完全一致）。 */
  importState(state: unknown): SamplerInfo {
    const s = state as ExportedState;
    if (!s || !Number.isInteger(s.k) || s.k < 1 || s.k > this.limits.maxCapacity) {
      throw new ApiError("INVALID_STATE", "状态中的容量非法");
    }
    if (!Number.isInteger(s.count) || s.count < 0 || s.count > this.limits.maxTotalRecords) {
      throw new ApiError("INVALID_STATE", "状态中的计数非法");
    }
    if (!Number.isInteger(s.rngState) || s.rngState < 0 || s.rngState > 0xffffffff) {
      throw new ApiError("INVALID_STATE", "状态中的 RNG 状态非法");
    }
    if (!Array.isArray(s.slots) || s.slots.length !== s.k) {
      throw new ApiError("INVALID_STATE", "状态中的槽数组长度必须等于 k");
    }
    const id = this.newId();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO samplers (id, k, count, rng_state, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, s.k, s.count, s.rngState, new Date().toISOString());
      const upsert = this.db.prepare("INSERT INTO slots (sampler_id, slot, position, payload) VALUES (?, ?, ?, ?)");
      s.slots.forEach((slot, i) => {
        if (slot !== null) {
          if (typeof slot !== "object" || !Number.isInteger(slot.position) || typeof slot.payload !== "string") {
            throw new ApiError("INVALID_STATE", `槽 ${i} 内容非法`);
          }
          upsert.run(id, i, slot.position, slot.payload);
        }
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getInfo(id);
  }
}
