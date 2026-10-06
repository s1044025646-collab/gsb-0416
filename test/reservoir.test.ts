import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Mulberry32, uniformBelow, Uint32Source } from "../src/rng";
import { ReservoirCore } from "../src/reservoir";
import { Store } from "../src/store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reservoir-test-"));
}

/** 可注入的理想随机整数源：按给定序列返回 uint32。 */
class ScriptSource implements Uint32Source {
  private i = 0;
  constructor(private values: number[]) {}
  nextUint32(): number {
    if (this.i >= this.values.length) throw new Error("脚本随机序列耗尽");
    return this.values[this.i++];
  }
}

test("流短于容量：全部进入样本，j 为 null", () => {
  const core = new ReservoirCore(5, new Mulberry32(1));
  const e1 = core.append("a");
  const e2 = core.append("b");
  assert.equal(e1.action, "filled");
  assert.equal(e1.j, null);
  assert.equal(core.count, 2);
  assert.deepEqual(core.snapshot().slots.map((s) => s.payload), ["a", "b"]);
});

test("恰好装满：k 条全部入选", () => {
  const core = new ReservoirCore(3, new Mulberry32(7));
  core.append("x");
  core.append("y");
  core.append("z");
  assert.equal(core.snapshot().slots.length, 3);
  assert.equal(core.count, 3);
});

test("重复载荷不去重：按到达位置区分", () => {
  const core = new ReservoirCore(2, new Mulberry32(3));
  core.append("same");
  core.append("same");
  const slots = core.snapshot().slots;
  assert.equal(slots.length, 2);
  assert.equal(slots[0].payload, "same");
  assert.equal(slots[1].payload, "same");
  assert.notEqual(slots[0].position, slots[1].position);
});

test("注入理想随机序列：独立核对槽变化", () => {
  // k=2。第 3 条：j 取自 [0,3)，给 1 -> 替换槽 1；第 4 条：j 取自 [0,4)，给 3 -> 丢弃
  const src = new ScriptSource([1, 3]);
  const core = new ReservoirCore(2, src);
  core.append("a");
  core.append("b");
  const e3 = core.append("c");
  assert.deepEqual([e3.j, e3.action, e3.slot], [1, "replaced", 1]);
  const e4 = core.append("d");
  assert.deepEqual([e4.j, e4.action, e4.slot], [3, "discarded", null]);
  assert.deepEqual(
    core.snapshot().slots.map((s) => [s.slot, s.position, s.payload]),
    [
      [0, 1, "a"],
      [1, 3, "c"],
    ],
  );
});

test("枚举 n=4,k=2 全部等概率路径：六个子集概率一致", () => {
  // 第 3 条 j ∈ [0,3)，第 4 条 j ∈ [0,4)，共 12 条等概率路径
  const subsets = new Map<string, number>();
  for (let j3 = 0; j3 < 3; j3++) {
    for (let j4 = 0; j4 < 4; j4++) {
      const core = new ReservoirCore(2, new ScriptSource([j3, j4]));
      [1, 2, 3, 4].forEach((p) => core.append(`r${p}`));
      const key = core
        .snapshot()
        .slots.map((s) => s.position)
        .sort((a, b) => a - b)
        .join(",");
      subsets.set(key, (subsets.get(key) ?? 0) + 1);
    }
  }
  assert.equal(subsets.size, 6); // C(4,2)=6
  for (const [, count] of subsets) assert.equal(count, 2); // 每个子集 2/12 = 1/6
});

test("uniformBelow 拒绝采样：拒绝 >= limit 的值后重新抽取", () => {
  // n=3：limit = floor(2^32/3)*3 = 4294967295，只有 4294967295 被拒绝
  const src = new ScriptSource([4294967295, 5]);
  assert.equal(uniformBelow(src, 3), 2); // 5 % 3 = 2
});

test("RNG 状态可序列化：恢复后序列一致", () => {
  const a = new Mulberry32(42);
  a.nextUint32();
  a.nextUint32();
  const state = a.getState();
  const b = Mulberry32.fromState(state);
  for (let i = 0; i < 10; i++) assert.equal(a.nextUint32(), b.nextUint32());
});

test("固定种子频率实验（辅助展示）：每个位置入选频率接近 k/n", () => {
  const k = 2;
  const n = 10;
  const trials = 20000;
  const hits = new Array(n).fill(0);
  const rng = new Mulberry32(2024);
  for (let t = 0; t < trials; t++) {
    const core = new ReservoirCore(k, rng);
    for (let p = 1; p <= n; p++) core.append(`r${p}`);
    for (const s of core.snapshot().slots) hits[s.position - 1]++;
  }
  for (const h of hits) {
    const freq = h / trials;
    assert.ok(Math.abs(freq - k / n) < 0.03, `频率 ${freq} 偏离 ${k / n}`);
  }
});

test("批次幂等：相同编号相同内容返回原结果，不多消耗随机数", () => {
  const store = new Store(tmpDir());
  const s = store.createSampler(2, 99);
  const r1 = store.appendBatch(s.id, "b1", ["a", "b", "c"]);
  const r2 = store.appendBatch(s.id, "b1", ["a", "b", "c"]);
  assert.equal(r2.idempotentReplay, true);
  assert.equal(r1.idempotentReplay, false);
  assert.deepEqual(r2.results, r1.results);
  assert.equal(store.getSample(s.id).count, 3); // 计数未翻倍
  assert.equal(store.getSample(s.id).rngState, r1.rngState); // 随机状态未前进
  store.close();
});

test("批次冲突：相同编号不同内容报 BATCH_CONFLICT", () => {
  const store = new Store(tmpDir());
  const s = store.createSampler(2, 1);
  store.appendBatch(s.id, "b1", ["a"]);
  assert.throws(() => store.appendBatch(s.id, "b1", ["b"]), /BATCH_CONFLICT|批次编号/);
  store.close();
});

test("失败回滚：非法批次不推进计数与随机状态", () => {
  const store = new Store(tmpDir());
  const s = store.createSampler(2, 5);
  store.appendBatch(s.id, "ok", ["a", "b"]);
  const before = store.getSample(s.id);
  assert.throws(() => store.appendBatch(s.id, "bad", ["x", 123 as unknown as string]));
  const after = store.getSample(s.id);
  assert.equal(after.count, before.count);
  assert.equal(after.rngState, before.rngState);
  assert.deepEqual(after.slots, before.slots);
  store.close();
});

test("重启恢复：从最后已提交状态继续，不重新播种", () => {
  const dir = tmpDir();
  const s1 = new Store(dir);
  const s = s1.createSampler(2, 77);
  s1.appendBatch(s.id, "b1", ["a", "b", "c"]);
  const before = s1.getSample(s.id);
  s1.close();

  const s2 = new Store(dir); // 模拟重启
  const resumed = s2.getSample(s.id);
  assert.deepEqual(resumed.slots, before.slots);
  assert.equal(resumed.rngState, before.rngState);
  // 重启后继续追加，与从未重启的连续运行一致
  s2.appendBatch(s.id, "b2", ["d"]);
  const afterRestart = s2.getSample(s.id);

  const dir2 = tmpDir();
  const s3 = new Store(dir2);
  const t = s3.createSampler(2, 77);
  s3.appendBatch(t.id, "b1", ["a", "b", "c"]);
  s3.appendBatch(t.id, "b2", ["d"]);
  const continuous = s3.getSample(t.id);
  assert.deepEqual(afterRestart.slots, continuous.slots);
  assert.equal(afterRestart.rngState, continuous.rngState);
  s2.close();
  s3.close();
});

test("分批方式不影响结果：相同种子相同输入顺序", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const records = ["a", "b", "c", "d", "e", "f"];
  const one = store.createSampler(3, 1234);
  store.appendBatch(one.id, "all", records);
  const two = store.createSampler(3, 1234);
  store.appendBatch(two.id, "p1", records.slice(0, 2));
  store.appendBatch(two.id, "p2", records.slice(2, 5));
  store.appendBatch(two.id, "p3", records.slice(5));
  assert.deepEqual(store.getSample(one.id).slots, store.getSample(two.id).slots);
  assert.equal(store.getSample(one.id).rngState, store.getSample(two.id).rngState);
  store.close();
});

test("参数校验：非法容量/超载荷/超批量", () => {
  const store = new Store(tmpDir());
  assert.throws(() => store.createSampler(0), /INVALID_CAPACITY|capacity/);
  assert.throws(() => store.createSampler(100001), /INVALID_CAPACITY|capacity/);
  const s = store.createSampler(2, 1);
  assert.throws(() => store.appendBatch(s.id, "b", ["x".repeat(5000)]), /INVALID_PAYLOAD|载荷/);
  assert.throws(
    () => store.appendBatch(s.id, "b", new Array(1001).fill("x")),
    /BATCH_TOO_LARGE|单批/,
  );
  store.close();
});

test("按原始位置排序展示不改变内部槽位", () => {
  const store = new Store(tmpDir());
  const s = store.createSampler(2, 8);
  store.appendBatch(s.id, "b1", ["a", "b", "c", "d", "e"]);
  const bySlot = store.getSample(s.id, "slot");
  const byPos = store.getSample(s.id, "position");
  assert.deepEqual(
    [...byPos.slots].map((x) => x.position),
    [...byPos.slots].map((x) => x.position).sort((a, b) => a - b),
  );
  // 内部槽位保持不变
  assert.deepEqual(store.getSample(s.id, "slot").slots, bySlot.slots);
  store.close();
});
