# 流式蓄水池抽样与随机状态恢复核验后端

基于 TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖）实现的未知长度数据流均匀抽样服务。只提供 HTTP API 与 CLI，无前端。Windows 本地直接运行，不依赖 Docker / WSL / 外部服务。

## 抽样模型：位置抽样（Algorithm R）

- 每条记录按**到达位置**（1 起）区分，相同载荷可出现多次，**不按内容去重**。
- 前 `k` 条依次进入样本；第 `n` 条（`n > k`）到达时，在 `[0, n)` 内均匀取整数 `j`：
  - `j < k`：用新记录**替换槽 j**；
  - `j >= k`：**丢弃**（未入选）。
- 每个已读位置最终以恰好 `k/n` 的概率留在样本中，且每个 k 子集等概率（测试中用 n=4, k=2 枚举全部 12 条等概率路径，验证 6 个子集各出现 2 次）。
- 样本未满时返回实际已有记录；容量一次运行内不可改变。
- 不保存被丢弃的载荷，不把整条流留在内存，O(k) 空间。

## 随机数与无偏映射

- PRNG：**Mulberry32**，状态为单个 uint32，可序列化、可恢复（`src/rng.ts`）。
- 范围映射：**拒绝采样**。只接受小于 `floor(2^32 / n) * n` 的随机数，拒绝后重抽再取余，无取模偏差（`uniformBelow`）。
- 总记录数上限 `2^32 - 1`，保证 `n` 落在 32 位随机整数范围内。
- 相同种子 + 相同输入顺序，任意分批方式得到相同样本与随机状态（有测试覆盖）。
- 重启后从 SQLite 中最后已提交的 `rng_state` 恢复，**不以当前时间重新播种**。

## 资源上限（`src/limits.ts`）

- 容量 `MAX_CAPACITY`：100,000
- 单条载荷 `MAX_PAYLOAD_BYTES`：4,096 字节
- 单批条数 `MAX_BATCH_SIZE`：1,000
- 总记录数 `MAX_TOTAL_COUNT`：2^32 - 1
- 解释日志保留 `LOG_RETENTION`：每抽样器最近 100 条
- 请求体 `MAX_BODY_BYTES`：8 MiB

## 构建、测试、启动、演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部测试（node:test）
npm start         # 启动 HTTP 服务（默认选择空闲端口）
npm run demo      # 演示：k=2 逐条 4 条记录 + 分批对比 + 幂等
```

### CLI

```powershell
node dist/src/cli.js serve --port=8080      # 可配置端口；省略则选空闲端口，也可用 PORT 环境变量
node dist/src/cli.js create 2 3             # 创建抽样器（容量 2，种子 3）
node dist/src/cli.js append <id> b1 a b c   # 批量追加（b1 为批次编号）
node dist/src/cli.js sample <id>            # 按槽位查询样本
node dist/src/cli.js sample <id> position   # 按原始位置排序展示（不改变内部槽位）
node dist/src/cli.js log <id> 10            # 最近 10 条替换解释
node dist/src/cli.js state <id>             # 导出已保存状态
```

数据目录默认为项目内 `data/`（可用 `DATA_DIR` 环境变量覆盖），各抽样器状态相互独立。

## HTTP API

- `POST /samplers`：创建，请求体 `{capacity, seed?}`
- `POST /samplers/:id/batches`：批量追加，请求体 `{batchId, records:[...]}`
- `GET /samplers/:id/sample?sort=slot|position`：查询样本（默认按槽位）
- `GET /samplers/:id/log?limit=N`：最近替换解释（含位置、j、被替换槽或未入选原因）
- `GET /samplers/:id/state`：导出状态（容量、计数、样本、种子、rngState、算法口径）

错误统一为 `{"error": {code, message}}`，错误码：`INVALID_CAPACITY`、`INVALID_SEED`、`INVALID_BATCH_ID`、`INVALID_PAYLOAD`、`BATCH_EMPTY`、`BATCH_TOO_LARGE`、`BATCH_CONFLICT`(409)、`COUNT_LIMIT_EXCEEDED`、`NOT_FOUND`(404)、`BAD_REQUEST`、`INTERNAL`。

## 幂等与事务

- 每批请求带唯一 `batchId`：
  - 相同编号 + 相同内容：返回首次保存的结果（`idempotentReplay: true`），**不多消耗随机数**；
  - 相同编号 + 不同内容：`409 BATCH_CONFLICT`。
- 先整批校验，再在**单个 SQLite 事务**中原子更新计数、样本槽位、随机状态、日志与批次记录；任一步失败整体回滚，随机状态不会单独前进。

## 测试与核验（`test/reservoir.test.ts`，共 15 例）

- 流短于容量、恰好装满、重复载荷不去重；
- 批次幂等、批次冲突、失败回滚、重启恢复（与连续运行逐位一致）；
- **可注入理想随机整数序列**独立核对槽变化；
- **枚举核验**：n=4, k=2 枚举全部 12 条等概率路径，6 个子集各出现 2 次（各 1/6）；
- 拒绝采样正确性（拒绝值触发重抽）、RNG 状态序列化往返；
- 固定种子频率实验仅作辅助展示，不代替上述枚举核验。

## 限制

- 仅等概率、不放回 Algorithm R；不支持加权采样、分布式样本合并、统计推断。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常提示。
- 单进程服务，未做横向扩展。
