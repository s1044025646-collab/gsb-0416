import { Mulberry32, Uint32Source, uniformBelow } from "./rng";

export interface SlotEntry {
  slot: number; // 槽位下标 0..k-1
  position: number; // 记录在流中的原始位置（1 起）
  payload: string;
}

export interface AppendExplanation {
  position: number; // 到达位置 n
  j: number | null; // 抽取的 j（n <= k 时无需抽取，为 null）
  action: "filled" | "replaced" | "discarded";
  slot: number | null; // 被写入/替换的槽位
  reason: string; // 中文解释
}

export interface ReservoirSnapshot {
  capacity: number;
  count: number;
  rngState: number;
  slots: SlotEntry[];
}

/**
 * Algorithm R 蓄水池抽样核心。
 * 前 k 条依次进入样本；第 n 条（n > k）在 [0, n) 均匀取 j，
 * j < k 时替换槽 j，否则丢弃。随机源可注入以便独立核验。
 */
export class ReservoirCore {
  readonly capacity: number;
  count: number;
  slots: SlotEntry[];
  private rng: Uint32Source;

  constructor(capacity: number, rng: Uint32Source, count = 0, slots: SlotEntry[] = []) {
    this.capacity = capacity;
    this.rng = rng;
    this.count = count;
    this.slots = slots;
  }

  /** 追加一条记录，返回本次抽样的解释。 */
  append(payload: string): AppendExplanation {
    this.count += 1;
    const n = this.count;
    if (n <= this.capacity) {
      const entry: SlotEntry = { slot: this.slots.length, position: n, payload };
      this.slots.push(entry);
      return {
        position: n,
        j: null,
        action: "filled",
        slot: entry.slot,
        reason: `第 ${n} 条，样本未满（容量 ${this.capacity}），直接进入槽 ${entry.slot}`,
      };
    }
    const j = uniformBelow(this.rng, n);
    if (j < this.capacity) {
      this.slots[j] = { slot: j, position: n, payload };
      return {
        position: n,
        j,
        action: "replaced",
        slot: j,
        reason: `第 ${n} 条，j=${j} < k=${this.capacity}，替换槽 ${j}`,
      };
    }
    return {
      position: n,
      j,
      action: "discarded",
      slot: null,
      reason: `第 ${n} 条，j=${j} >= k=${this.capacity}，未入选丢弃`,
    };
  }

  snapshot(): ReservoirSnapshot {
    return {
      capacity: this.capacity,
      count: this.count,
      rngState: this.rng instanceof Mulberry32 ? this.rng.getState() : -1,
      slots: this.slots.map((s) => ({ ...s })),
    };
  }
}
