import { test } from "node:test";
import assert from "node:assert/strict";
import { Reservoir } from "../src/reservoir";
import { Mulberry32, Rng, randBelow } from "../src/rng";

/** 可注入的理想随机整数序列，用于独立核对槽变化。 */
class ScriptRng implements Rng {
  private i = 0;
  constructor(private readonly seq: number[]) {}
  nextUint32(): number {
    if (this.i >= this.seq.length) throw new Error("序列耗尽");
    return this.seq[this.i++];
  }
  getState(): unknown {
    return this.i;
  }
}

test("流短于容量：全部入样，样本未满返回实际数量", () => {
  const r = new Reservoir(5, new Mulberry32(1));
  r.offer("a");
  r.offer("b");
  const slots = r.getSlots();
  assert.equal(r.processedCount, 2);
  assert.deepEqual(slots[0], { position: 1, payload: "a" });
  assert.deepEqual(slots[1], { position: 2, payload: "b" });
  assert.equal(slots[2], null);
});

test("恰好装满：不消耗随机数，依次入槽", () => {
  const rng = new ScriptRng([]);
  const r = new Reservoir(2, rng);
  r.offer("x");
  r.offer("y");
  assert.equal(r.processedCount, 2);
  assert.equal(r.getSlots()[1]!.position, 2);
});

test("重复载荷按位置区分，不去重", () => {
  const r = new Reservoir(3, new Mulberry32(7));
  r.offer("same");
  r.offer("same");
  r.offer("same");
  const positions = r.getSlots().map((s) => s!.position);
  assert.deepEqual(positions, [1, 2, 3]);
});

test("注入理想序列独立核对槽变化（k=2, n=4）", () => {
  // 第 3 条：j=0 -> 替换槽 0；第 4 条：j=3 (>=k) -> 丢弃
  const r = new Reservoir(2, new ScriptRng([0, 3]));
  const s3 = r.offer("a");
  r.offer("b");
  const e3 = r.offer("c");
  const e4 = r.offer("d");
  assert.equal(e3.action, "replace");
  assert.equal(e3.slot, 0);
  assert.equal(e4.action, "skip");
  assert.equal(e4.j, 3);
  const slots = r.getSlots();
  assert.deepEqual(slots[0], { position: 3, payload: "c" });
  assert.deepEqual(slots[1], { position: 2, payload: "b" });
  void s3;
});

test("枚举 k=2,n=4 全部等概率路径：六个子集各出现恰好两次", () => {
  // 第 3 条 j ∈ {0,1,2}，第 4 条 j ∈ {0,1,2,3}，共 12 条等概率路径
  const counts = new Map<string, number>();
  for (let j3 = 0; j3 < 3; j3++) {
    for (let j4 = 0; j4 < 4; j4++) {
      const r = new Reservoir(2, new ScriptRng([j3, j4]));
      for (const p of ["1", "2", "3", "4"]) r.offer(p);
      const key = r
        .getSlots()
        .map((s) => s!.position)
        .sort((a, b) => a - b)
        .join(",");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  assert.equal(counts.size, 6);
  for (const [key, c] of counts) {
    assert.equal(c, 2, `子集 ${key} 概率应为 2/12`);
  }
});

test("randBelow 无取模偏差：拒绝采样只接受完整区间", () => {
  // n=3，limit = floor(2^32/3)*3 = 4294967295；注入越界值应被拒绝重取
  const rng = new ScriptRng([4294967295, 5]);
  const v = randBelow(rng, 3);
  assert.equal(v, 2); // 5 % 3
});

test("相同种子相同输入，任意分批结果一致", () => {
  const mk = () => new Reservoir(2, new Mulberry32(99));
  const a = mk();
  ["p", "q", "r", "s", "t"].forEach((p) => a.offer(p));
  const b = mk();
  ["p", "q"].forEach((p) => b.offer(p));
  ["r", "s", "t"].forEach((p) => b.offer(p));
  assert.deepEqual(a.getSlots(), b.getSlots());
  assert.equal(a.getRng().getState(), b.getRng().getState());
});
