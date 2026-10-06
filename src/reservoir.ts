import { Rng, randBelow } from "./rng";

/** 一个样本槽：记录原始到达位置（从 1 开始）与业务载荷。 */
export interface Slot {
  position: number;
  payload: string;
}

export type StepAction = "insert" | "replace" | "skip";

/** 单条记录处理过程的解释。 */
export interface StepExplanation {
  /** 记录到达位置 n（从 1 开始）。 */
  position: number;
  /** 本次抽取的 j（n <= k 时无需抽取，为 null）。 */
  j: number | null;
  action: StepAction;
  /** insert/replace 时落入的槽号，skip 时为 null。 */
  slot: number | null;
  /** 中文原因说明。 */
  reason: string;
}

/**
 * Algorithm R 蓄水池抽样核心。
 * 前 k 条依次入槽；第 n 条 (n > k) 在 [0, n) 均匀取 j，
 * j < k 时替换槽 j，否则丢弃。容量运行期不可变。
 */
export class Reservoir {
  readonly k: number;
  private readonly rng: Rng;
  private count: number;
  private readonly slots: (Slot | null)[];

  constructor(k: number, rng: Rng, count = 0, slots?: (Slot | null)[]) {
    if (!Number.isInteger(k) || k < 1) throw new Error("容量 k 必须是正整数");
    this.k = k;
    this.rng = rng;
    this.count = count;
    this.slots = slots ? slots.slice(0, k) : new Array<Slot | null>(k).fill(null);
    while (this.slots.length < k) this.slots.push(null);
  }

  get processedCount(): number {
    return this.count;
  }

  getRng(): Rng {
    return this.rng;
  }

  /** 处理一条新记录，返回解释。position 由内部计数推导。 */
  offer(payload: string): StepExplanation {
    const n = this.count + 1;
    this.count = n;
    if (n <= this.k) {
      const slot = n - 1;
      this.slots[slot] = { position: n, payload };
      return {
        position: n,
        j: null,
        action: "insert",
        slot,
        reason: `样本未满，第 ${n} 条直接进入槽 ${slot}`,
      };
    }
    const j = randBelow(this.rng, n);
    if (j < this.k) {
      this.slots[j] = { position: n, payload };
      return {
        position: n,
        j,
        action: "replace",
        slot: j,
        reason: `j=${j} < k=${this.k}，新记录替换槽 ${j}`,
      };
    }
    return {
      position: n,
      j,
      action: "skip",
      slot: null,
      reason: `j=${j} >= k=${this.k}，第 ${n} 条未入选`,
    };
  }

  /** 当前槽内容（按槽序，未填满时含 null）。 */
  getSlots(): (Slot | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }
}
