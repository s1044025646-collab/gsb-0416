import { DatabaseSync } from "node:sqlite";
import { createHash, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Mulberry32 } from "./rng";
import { AppendExplanation, ReservoirCore, ReservoirSnapshot, SlotEntry } from "./reservoir";
import { ApiError } from "./errors";
import { LIMITS } from "./limits";

export interface BatchRecordResult extends AppendExplanation {
  payload: string;
}

export interface BatchResponse {
  samplerId: string;
  batchId: string;
  accepted: number;
  count: number;
  rngState: number;
  idempotentReplay: boolean;
  results: BatchRecordResult[];
}

interface SamplerRow {
  id: string;
  capacity: number;
  count: number;
  rng_state: number;
  seed: number;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "reservoir.db");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samplers (
        id TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL,
        count INTEGER NOT NULL,
        rng_state INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slots (
        sampler_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (sampler_id, slot)
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sampler_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        j INTEGER,
        action TEXT NOT NULL,
        slot INTEGER,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        sampler_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (sampler_id, batch_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSampler(capacity: number, seed?: number): { id: string; capacity: number; seed: number } {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > LIMITS.MAX_CAPACITY) {
      throw new ApiError("INVALID_CAPACITY", `capacity 须为 1..${LIMITS.MAX_CAPACITY} 的整数`);
    }
    const actualSeed = seed === undefined ? randomInt(0, 0x100000000) : seed;
    if (!Number.isInteger(actualSeed) || actualSeed < 0 || actualSeed > 0xffffffff) {
      throw new ApiError("INVALID_SEED", "seed 须为 0..2^32-1 的整数");
    }
    const id = createHash("sha256")
      .update(`${actualSeed}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    const rng = new Mulberry32(actualSeed);
    this.db
      .prepare(
        "INSERT INTO samplers (id, capacity, count, rng_state, seed, created_at) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run(id, capacity, rng.getState(), actualSeed, new Date().toISOString());
    return { id, capacity, seed: actualSeed };
  }

  private getSamplerRow(id: string): SamplerRow {
    const row = this.db.prepare("SELECT * FROM samplers WHERE id = ?").get(id) as
      | SamplerRow
      | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `抽样器不存在: ${id}`, 404);
    return row;
  }

  private loadSlots(id: string): SlotEntry[] {
    const rows = this.db
      .prepare("SELECT slot, position, payload FROM slots WHERE sampler_id = ? ORDER BY slot")
      .all(id) as unknown as SlotEntry[];
    return rows.map((r) => ({ slot: Number(r.slot), position: Number(r.position), payload: r.payload }));
  }

  private loadCore(id: string): ReservoirCore {
    const row = this.getSamplerRow(id);
    const rng = Mulberry32.fromState(Number(row.rng_state));
    return new ReservoirCore(Number(row.capacity), rng, Number(row.count), this.loadSlots(id));
  }

  /**
   * 批量追加。先整批校验，再在单个事务中原子更新计数、样本与随机状态；
   * 任何失败回滚后随机状态不会单独前进。
   * 相同 batchId + 相同内容：返回首次保存的结果（幂等重放，不消耗随机数）；
   * 相同 batchId + 不同内容：409 冲突。
   */
  appendBatch(id: string, batchId: string, payloads: string[]): BatchResponse {
    if (typeof batchId !== "string" || batchId.length === 0 || batchId.length > 128) {
      throw new ApiError("INVALID_BATCH_ID", "batchId 须为 1..128 字符的字符串");
    }
    if (!Array.isArray(payloads) || payloads.length === 0) {
      throw new ApiError("BATCH_EMPTY", "records 须为非空数组");
    }
    if (payloads.length > LIMITS.MAX_BATCH_SIZE) {
      throw new ApiError("BATCH_TOO_LARGE", `单批最多 ${LIMITS.MAX_BATCH_SIZE} 条`);
    }
    for (const p of payloads) {
      if (typeof p !== "string" || Buffer.byteLength(p, "utf8") > LIMITS.MAX_PAYLOAD_BYTES) {
        throw new ApiError(
          "INVALID_PAYLOAD",
          `每条载荷须为不超过 ${LIMITS.MAX_PAYLOAD_BYTES} 字节的字符串`,
        );
      }
    }

    const hash = createHash("sha256").update(JSON.stringify(payloads)).digest("hex");
    const existing = this.db
      .prepare("SELECT hash, response FROM batches WHERE sampler_id = ? AND batch_id = ?")
      .get(id, batchId) as { hash: string; response: string } | undefined;
    if (existing) {
      if (existing.hash !== hash) {
        throw new ApiError("BATCH_CONFLICT", `批次编号 ${batchId} 已用于不同内容`, 409);
      }
      const replay = JSON.parse(existing.response) as BatchResponse;
      replay.idempotentReplay = true;
      return replay;
    }

    const core = this.loadCore(id);
    if (core.count + payloads.length > LIMITS.MAX_TOTAL_COUNT) {
      throw new ApiError(
        "COUNT_LIMIT_EXCEEDED",
        `总记录数不能超过 ${LIMITS.MAX_TOTAL_COUNT}（32 位随机整数范围）`,
      );
    }

    // 先在内存副本上完整模拟，再一次性落库；任一步失败不会部分提交。
    const results: BatchRecordResult[] = payloads.map((p) => ({ ...core.append(p), payload: p }));
    const snap = core.snapshot();

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE samplers SET count = ?, rng_state = ? WHERE id = ?")
        .run(snap.count, snap.rngState, id);
      this.db.prepare("DELETE FROM slots WHERE sampler_id = ?").run(id);
      const insSlot = this.db.prepare(
        "INSERT INTO slots (sampler_id, slot, position, payload) VALUES (?, ?, ?, ?)",
      );
      for (const s of snap.slots) insSlot.run(id, s.slot, s.position, s.payload);
      const insLog = this.db.prepare(
        "INSERT INTO logs (sampler_id, position, j, action, slot, reason) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of results) insLog.run(id, r.position, r.j, r.action, r.slot, r.reason);
      // 日志保留上限：只保留最近 LOG_RETENTION 条
      this.db
        .prepare(
          `DELETE FROM logs WHERE sampler_id = ? AND id NOT IN
             (SELECT id FROM logs WHERE sampler_id = ? ORDER BY id DESC LIMIT ?)`,
        )
        .run(id, id, LIMITS.LOG_RETENTION);
      const response: BatchResponse = {
        samplerId: id,
        batchId,
        accepted: results.length,
        count: snap.count,
        rngState: snap.rngState,
        idempotentReplay: false,
        results,
      };
      this.db
        .prepare("INSERT INTO batches (sampler_id, batch_id, hash, response) VALUES (?, ?, ?, ?)")
        .run(id, batchId, hash, JSON.stringify(response));
      this.db.exec("COMMIT");
      return response;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getSample(id: string, sort: "slot" | "position" = "slot"): ReservoirSnapshot & { id: string } {
    const core = this.loadCore(id);
    const snap = core.snapshot();
    if (sort === "position") {
      // 仅展示排序，不改变内部槽位
      snap.slots = [...snap.slots].sort((a, b) => a.position - b.position);
    }
    return { id, ...snap };
  }

  getLog(id: string, limit = 20): unknown[] {
    this.getSamplerRow(id);
    const n = Math.max(1, Math.min(limit, LIMITS.LOG_RETENTION));
    return this.db
      .prepare(
        "SELECT position, j, action, slot, reason FROM logs WHERE sampler_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(id, n) as unknown[];
  }

  exportState(id: string): unknown {
    const row = this.getSamplerRow(id);
    return {
      id: row.id,
      capacity: Number(row.capacity),
      count: Number(row.count),
      seed: Number(row.seed),
      rngState: Number(row.rng_state),
      rngAlgorithm: "Mulberry32",
      rangeMapping: "rejection-sampling (无取模偏差)",
      slots: this.loadSlots(id),
    };
  }
}
