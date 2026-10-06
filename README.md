# 流式蓄水池抽样与随机状态恢复核验后端

TypeScript + Node.js + SQLite（`node:sqlite`，Node ≥ 22.5，无需原生编译）实现的
**Algorithm R** 等概率、不放回流式抽样服务。只做 API 与 CLI，Windows 本地运行，
不依赖 Docker / WSL / 外部服务。

## 抽样模型（位置抽样）

- 每条记录按**到达位置 n（从 1 开始）**区分，相同载荷可出现多次，不按内容去重。
- 前 k 条依次进入槽 0..k-1；第 n 条（n > k）在 **[0, n) 均匀取整数 j**：
  `j < k` 时新记录替换槽 j，否则丢弃（Algorithm R，每条记录以恰好 k/n 的概率留在样本中）。
- 容量 k 创建后不可改变；不把整条流保存在内存，只保留 k 个槽 + 计数 + RNG 状态。
- 总记录数上限 `2^32 - 1`（位置需映射到 32 位随机整数范围内）。

## 随机数与无偏映射

- PRNG：**mulberry32**（公开算法，单 uint32 状态，可 JSON 序列化，见 `src/rng.ts`）。
- 范围映射：**拒绝采样**——只接受落在 `floor(2^32/n)*n` 内的随机数，越界重取，
  无取模偏差（`randBelow`，`src/rng.ts`）。
- 种子相同、输入顺序相同，**任意分批方式**得到相同样本与随机状态（测试与演示均核验）。
- 重启后从 SQLite 中最后提交的 RNG 状态继续，不以当前时间重新播种。

## 资源上限（`src/store.ts` 中 `DEFAULT_LIMITS`）

| 限制 | 默认值 | 错误码 |
|---|---|---|
| 容量 k | ≤ 10000 | `INVALID_CAPACITY` |
| 单条载荷 | ≤ 16 KiB | `PAYLOAD_TOO_LARGE` |
| 单批条数 | ≤ 1000 | `BATCH_TOO_LARGE` |
| 总记录数 | ≤ 2^32 - 1 | `COUNT_LIMIT_EXCEEDED` |
| 解释日志保留 | 最近 1000 条（自动裁剪，不无限增长） | — |

其他错误码：`INVALID_SEED`、`INVALID_BATCH_ID`、`EMPTY_BATCH`、`INVALID_PAYLOAD`、
`BATCH_CONFLICT`(409)、`NOT_FOUND`(404)、`INVALID_STATE`、`BAD_JSON`、`BODY_TOO_LARGE`(413)。

## 幂等与原子性

- 每批需唯一 `batchId`：相同编号 + 相同内容 → 返回原结果（`idempotentReplay: true`），
  不多消耗随机数；相同编号 + 不同内容 → 409 `BATCH_CONFLICT`。
- **先校验整批**，再在一个 SQLite 事务中原子更新计数、样本槽、RNG 状态、日志与批次记录；
  任何失败整体回滚，随机状态不会单独前进。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅 devDependencies: typescript, @types/node
npm run build      # tsc -> dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 HTTP 服务，默认端口 0（自动选空闲端口），PORT=8080 可指定
npm run demo       # 演示：k=2 逐条 4 条记录 + 分批一致性 + 幂等
npm run cli -- create --k 2 --seed 42
```

数据目录：项目内 `data/`（`DB_PATH` 环境变量可覆盖）。各抽样器状态相互独立。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/samplers` | 创建 `{k, seed?}` |
| GET | `/samplers/:id` | 容量与已处理计数 |
| POST | `/samplers/:id/batches` | 批量追加 `{batchId, records: string[]}` |
| GET | `/samplers/:id/sample?sort=slot\|position` | 查询样本；`position` 仅展示排序，不改内部槽 |
| GET | `/samplers/:id/log?limit=N` | 最近 N 条替换解释（含位置、j、槽/未入选原因） |
| GET | `/samplers/:id/state` | 导出完整状态（k、count、rngState、slots） |
| POST | `/import` | 用导出的状态创建新抽样器（新 id） |

错误响应统一为 `{"error": {"code": "...", "message": "..."}}`。

## CLI

```powershell
npm run cli -- create --k 2 --seed 42
npm run cli -- append --id <id> --batch-id b1 --records a,b,c
npm run cli -- append --id <id> --batch-id b2 --file records.json
npm run cli -- sample --id <id> --sort position
npm run cli -- log --id <id> --limit 20
npm run cli -- export --id <id> --file state.json
npm run cli -- import --file state.json
```

## 核验方法（`test/`）

- **理想序列注入**：`ScriptRng` 注入指定 j 序列，独立核对每一步槽变化（replace/skip/insert）。
- **枚举核验**：k=2、n=4 时第 3 条 j∈{0,1,2}、第 4 条 j∈{0,1,2,3}，共 12 条等概率路径，
  枚举确认 C(4,2)=6 个子集各出现恰好 2 次（概率均为 1/6）。
- 场景测试：流短于容量、恰好装满、重复载荷、批次幂等、冲突 409、失败回滚
  （计数与 RNG 状态不前进）、重启恢复（文件库重开后续跑与连续运行一致）、
  导出/导入一致性、日志保留上限、排序展示不改内部槽。
- 固定种子频率实验只能辅助展示，不能代替上述枚举核验（本项目以枚举为准）。

## 已知限制

- 仅等概率 Algorithm R；不含加权抽样、分布式样本合并、统计推断。
- 单进程服务；`node:sqlite` 在 Node 25 仍打印 ExperimentalWarning（功能可用）。
- 解释日志只保留最近 1000 条；被丢弃记录的载荷不持久化。
