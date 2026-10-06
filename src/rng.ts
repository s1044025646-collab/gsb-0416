/** 可序列化状态的伪随机数生成器接口。 */
export interface Rng {
  /** 返回 [0, 2^32) 内均匀分布的无符号 32 位整数。 */
  nextUint32(): number;
  /** 导出可 JSON 序列化的内部状态。 */
  getState(): unknown;
}

/**
 * mulberry32：公开的单状态 32 位 PRNG（周期 2^32）。
 * 状态为一个 uint32，种子相同则序列完全相同。
 */
export class Mulberry32 implements Rng {
  private s: number;
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error("seed 必须是 [0, 2^32) 内的整数");
    }
    this.s = seed >>> 0;
  }
  static fromState(state: unknown): Mulberry32 {
    if (typeof state !== "number" || !Number.isInteger(state) || state < 0 || state > 0xffffffff) {
      throw new Error("非法的 RNG 状态");
    }
    const rng = Object.create(Mulberry32.prototype) as Mulberry32;
    rng.s = state >>> 0;
    return rng;
  }
  nextUint32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }
  getState(): number {
    return this.s;
  }
}

/**
 * 拒绝采样：把均匀 uint32 映射到 [0, n)，无取模偏差。
 * 只接受落在最大 n 的整数倍区间内的随机数，其余拒绝重取。
 * n 必须满足 1 <= n <= 2^32。
 */
export function randBelow(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) {
    throw new Error("randBelow 上界必须在 [1, 2^32] 内");
  }
  if (n === 0x100000000) return rng.nextUint32();
  const limit = Math.floor(0x100000000 / n) * n;
  let x: number;
  do {
    x = rng.nextUint32();
  } while (x >= limit);
  return x % n;
}
