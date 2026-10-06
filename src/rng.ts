/**
 * 有种子、可序列化状态的 32 位伪随机数生成器（Mulberry32）。
 * 状态为单个 uint32，可直接序列化/恢复。
 */
export class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  static fromState(state: number): Mulberry32 {
    const rng = new Mulberry32(0);
    rng.state = state >>> 0;
    return rng;
  }

  getState(): number {
    return this.state >>> 0;
  }

  /** 返回 [0, 2^32) 均匀分布的 32 位无符号整数。 */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
}

/** 可从外部注入的随机整数源（便于测试注入理想序列）。 */
export interface Uint32Source {
  nextUint32(): number;
}

const TWO_POW_32 = 0x100000000;

/**
 * 将 32 位均匀随机整数无偏映射到 [0, n)。
 * 使用拒绝采样：只接受小于 limit = floor(2^32 / n) * n 的值，
 * 拒绝后重新抽取，因此不存在取模偏差。
 * 要求 1 <= n <= 2^32。
 */
export function uniformBelow(rng: Uint32Source, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_POW_32) {
    throw new Error(`uniformBelow: n 超出范围: ${n}`);
  }
  const limit = Math.floor(TWO_POW_32 / n) * n;
  let x: number;
  do {
    x = rng.nextUint32();
  } while (x >= limit);
  return x % n;
}
