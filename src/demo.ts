import { Store } from "./store";

/** 演示：容量 2，逐条读取 4 条记录，展示一次替换与一次未入选；
 *  再对比“分两批”与“一次提交”在相同种子下结果完全一致。 */
function main(): void {
  const store = new Store(":memory:");
  const SEED = 42;
  const RECORDS = ["alpha", "bravo", "charlie", "delta"];

  console.log("=== 第一部分：容量 k=2，逐条追加 4 条记录 ===");
  const s1 = store.createSampler(2, SEED);
  console.log(`抽样器 ${s1.id}，k=2，seed=${SEED}`);
  RECORDS.forEach((payload, i) => {
    const r = store.appendBatch(s1.id, `demo-1-${i}`, [payload]);
    const step = r.steps[0];
    console.log(
      `第 ${step.position} 条 "${payload}": j=${step.j ?? "-"} -> ${step.action}（${step.reason}）`,
    );
  });
  const final1 = store.getSample(s1.id);
  const state1 = store.exportState(s1.id);
  console.log("最终样本（按槽）:", JSON.stringify(final1.sample));
  console.log("RNG 状态:", state1.rngState);

  console.log("\n=== 第二部分：相同种子与输入，不同分批方式 ===");
  const s2 = store.createSampler(2, SEED);
  store.appendBatch(s2.id, "demo-2-a", RECORDS.slice(0, 2));
  store.appendBatch(s2.id, "demo-2-b", RECORDS.slice(2));
  const state2 = store.exportState(s2.id);

  const s3 = store.createSampler(2, SEED);
  store.appendBatch(s3.id, "demo-3-a", RECORDS);
  const state3 = store.exportState(s3.id);

  const same =
    JSON.stringify(state1.slots) === JSON.stringify(state2.slots) &&
    JSON.stringify(state1.slots) === JSON.stringify(state3.slots) &&
    state1.rngState === state2.rngState &&
    state1.rngState === state3.rngState;
  console.log("逐条 x4 样本:", JSON.stringify(state1.slots));
  console.log("分两批  样本:", JSON.stringify(state2.slots));
  console.log("一次提交 样本:", JSON.stringify(state3.slots));
  console.log(`三种分批方式样本与 RNG 状态完全一致: ${same ? "是 ✔" : "否 ✘"}`);

  console.log("\n=== 第三部分：幂等重放与冲突 ===");
  const replay = store.appendBatch(s3.id, "demo-3-a", RECORDS);
  console.log(`相同批次号+相同内容重放: idempotentReplay=${replay.idempotentReplay}，计数仍为 ${replay.totalCount}`);
  try {
    store.appendBatch(s3.id, "demo-3-a", ["different"]);
  } catch (err: any) {
    console.log(`相同批次号+不同内容: ${err.code} - ${err.message}`);
  }
  store.close();
}

main();
