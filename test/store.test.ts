import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, ApiError } from "../src/store";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resv-")), "test.db");
}

test("批次幂等：相同编号相同内容返回原结果，不多消耗随机数", () => {
  const store = new Store(":memory:");
  const s = store.createSampler(2, 42);
  const r1 = store.appendBatch(s.id, "b1", ["a", "b", "c"]);
  const r2 = store.appendBatch(s.id, "b1", ["a", "b", "c"]);
  assert.equal(r2.idempotentReplay, true);
  assert.deepEqual(r2.steps, r1.steps);
  assert.equal(store.getInfo(s.id).count, 3);
  store.close();
});

test("批次冲突：相同编号不同内容报 409", () => {
  const store = new Store(":memory:");
  const s = store.createSampler(2, 42);
  store.appendBatch(s.id, "b1", ["a"]);
  assert.throws(() => store.appendBatch(s.id, "b1", ["b"]), (e: ApiError) => e.code === "BATCH_CONFLICT" && e.status === 409);
  store.close();
});

test("失败回滚：非法批次不推进计数与随机状态", () => {
  const store = new Store(":memory:");
  const s = store.createSampler(2, 42);
  store.appendBatch(s.id, "ok", ["a", "b"]);
  const before = store.exportState(s.id);
  assert.throws(
    () => store.appendBatch(s.id, "bad", ["c", 123 as unknown as string]),
    (e: ApiError) => e.code === "INVALID_PAYLOAD",
  );
  const after = store.exportState(s.id);
  const strip = (x: { id: string }) => {
    const { id: _id, ...rest } = x;
    return rest;
  };
  assert.deepEqual(strip(after), strip(before));
  // 后续合法批次应与失败从未发生的结果一致
  const store2 = new Store(":memory:");
  const s2 = store2.createSampler(2, 42);
  store2.appendBatch(s2.id, "ok", ["a", "b"]);
  store2.appendBatch(s2.id, "next", ["c", "d"]);
  store.appendBatch(s.id, "next", ["c", "d"]);
  assert.deepEqual(strip(store.exportState(s.id)), strip(store2.exportState(s2.id)));
  store.close();
  store2.close();
});

test("重启恢复：从最后提交状态继续，不重新播种", () => {
  const db = tmpDb();
  const store1 = new Store(db);
  const s = store1.createSampler(2, 42);
  store1.appendBatch(s.id, "b1", ["a", "b", "c"]);
  const stateBefore = store1.exportState(s.id);
  store1.close();

  const store2 = new Store(db);
  const stateAfter = store2.exportState(s.id);
  assert.deepEqual(stateAfter, stateBefore);
  // 继续追加应与未重启的连续运行一致
  const store3 = new Store(":memory:");
  const s3 = store3.createSampler(2, 42);
  store3.appendBatch(s3.id, "b1", ["a", "b", "c"]);
  store3.appendBatch(s3.id, "b2", ["d", "e"]);
  store2.appendBatch(s.id, "b2", ["d", "e"]);
  const got = store2.exportState(s.id);
  const want = store3.exportState(s3.id);
  assert.deepEqual(got.slots, want.slots);
  assert.equal(got.rngState, want.rngState);
  assert.equal(got.count, want.count);
  store2.close();
  store3.close();
});

test("导出/导入状态：导入后继续运行与原件一致", () => {
  const store = new Store(":memory:");
  const a = store.createSampler(3, 7);
  store.appendBatch(a.id, "b1", ["1", "2", "3", "4", "5"]);
  const state = store.exportState(a.id);
  const b = store.importState(state);
  store.appendBatch(a.id, "b2", ["6", "7"]);
  store.appendBatch(b.id, "b2", ["6", "7"]);
  const sa = store.exportState(a.id);
  const sb = store.exportState(b.id);
  assert.deepEqual(sa.slots, sb.slots);
  assert.equal(sa.rngState, sb.rngState);
  // 状态相互独立：演示数据不影响其他抽样器
  store.appendBatch(b.id, "b3", ["x"]);
  assert.notEqual(store.exportState(a.id).rngState, store.exportState(b.id).rngState);
  store.close();
});

test("限制校验：容量、批量、载荷大小", () => {
  const store = new Store(":memory:", { maxCapacity: 4, maxBatchRecords: 2, maxPayloadBytes: 3 });
  assert.throws(() => store.createSampler(5), (e: ApiError) => e.code === "INVALID_CAPACITY");
  const s = store.createSampler(2, 1);
  assert.throws(() => store.appendBatch(s.id, "x", ["a", "b", "c"]), (e: ApiError) => e.code === "BATCH_TOO_LARGE");
  assert.throws(() => store.appendBatch(s.id, "x", ["toolong"]), (e: ApiError) => e.code === "PAYLOAD_TOO_LARGE");
  assert.equal(store.getInfo(s.id).count, 0);
  store.close();
});

test("日志保留上限：不无限增长", () => {
  const store = new Store(":memory:", { logRetention: 10 });
  const s = store.createSampler(1, 1);
  for (let i = 0; i < 30; i++) store.appendBatch(s.id, `b${i}`, [`r${i}`]);
  const entries = store.getLog(s.id, 1000);
  assert.equal(entries.length, 10);
  assert.equal(entries[entries.length - 1].position, 30);
  store.close();
});

test("样本排序：按位置排序不改变内部槽", () => {
  const store = new Store(":memory:");
  const s = store.createSampler(2, 42);
  store.appendBatch(s.id, "b1", ["a", "b", "c", "d", "e"]);
  const bySlot = store.getSample(s.id, "slot");
  const byPos = store.getSample(s.id, "position");
  assert.deepEqual(
    [...byPos.sample].sort((x, y) => x.slot - y.slot),
    bySlot.sample,
  );
  store.close();
});
