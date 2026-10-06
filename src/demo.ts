import { Store } from "./store";
import { ReservoirCore } from "./reservoir";
import { Mulberry32 } from "./rng";

/**
 * 演示：容量 2，逐条读取 4 条记录（展示一次替换与一次不入选），
 * 再对比「分两批」与「一次提交」得到完全相同的样本与随机状态。
 * 为保证演示同时出现替换与丢弃，确定性搜索一个满足条件的种子。
 */
export function runDemo(store: Store, log: (s: string) => void = console.log): void {
  const records = ["alpha", "bravo", "charlie", "delta"];

  // 确定性搜索（纯内存，不写库）：找到第 3、4 条中恰好一次替换、一次丢弃的种子
  let demoSeed = -1;
  for (let seed = 0; seed < 10000; seed++) {
    const core = new ReservoirCore(2, new Mulberry32(seed));
    const actions = records.map((r) => core.append(r).action);
    const tail = actions.slice(2).sort().join(",");
    if (tail === "discarded,replaced") {
      demoSeed = seed;
      break;
    }
  }

  log("=== 演示 1：容量 k=2，逐条读取 4 条记录 ===");
  const a = store.createSampler(2, demoSeed);
  log(`创建抽样器 id=${a.id} seed=${a.seed} capacity=2`);
  records.forEach((rec, i) => {
    const r = store.appendBatch(a.id, `b${i + 1}`, [rec]);
    const e = r.results[0];
    log(`  [${e.position}] ${rec} -> ${e.reason}`);
  });
  const sampleA = store.getSample(a.id);
  log(`最终样本（按槽位）: ${JSON.stringify(sampleA.slots)}`);
  log(`随机状态 rngState=${sampleA.rngState}, count=${sampleA.count}`);
  log(`最近解释日志: ${JSON.stringify(store.getLog(a.id, 4), null, 2)}`);

  log("");
  log("=== 演示 2：同样输入，分两批 vs 一次提交 ===");
  const b = store.createSampler(2, demoSeed);
  store.appendBatch(b.id, "x1", records.slice(0, 2));
  store.appendBatch(b.id, "x2", records.slice(2));
  const sampleB = store.getSample(b.id);

  const c = store.createSampler(2, demoSeed);
  store.appendBatch(c.id, "y1", records);
  const sampleC = store.getSample(c.id);

  const same =
    JSON.stringify(sampleB.slots) === JSON.stringify(sampleC.slots) &&
    sampleB.rngState === sampleC.rngState;
  log(`分两批样本: ${JSON.stringify(sampleB.slots)} rngState=${sampleB.rngState}`);
  log(`一次提交样本: ${JSON.stringify(sampleC.slots)} rngState=${sampleC.rngState}`);
  log(`分批方式不影响结果: ${same ? "通过 ✔" : "失败 �’"}`);

  log("");
  log("=== 演示 3：批次幂等 ===");
  const first = store.appendBatch(c.id, "y1", records);
  log(`相同 batchId+相同内容重复提交: idempotentReplay=${first.idempotentReplay}, count 仍为 ${first.count}（未多消耗随机数）`);
  try {
    store.appendBatch(c.id, "y1", ["different"]);
  } catch (err: any) {
    log(`相同 batchId+不同内容: ${err.code} ${err.message}`);
  }
}
