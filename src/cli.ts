import * as path from "node:path";
import { Store } from "./store";
import { createServer } from "./server";
import { runDemo } from "./demo";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const store = new Store(dataDir);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const portArg = args.find((a) => a.startsWith("--port="));
      const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0); // 默认空闲端口
      const server = createServer(store);
      server.listen(port, () => {
        const addr = server.address();
        console.log(`服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
        console.log(`数据目录: ${dataDir}`);
      });
      break;
    }
    case "create":
      print(store.createSampler(Number(args[0]), args[1] === undefined ? undefined : Number(args[1])));
      break;
    case "append": {
      const [id, batchId, ...records] = args;
      print(store.appendBatch(id, batchId, records));
      break;
    }
    case "sample":
      print(store.getSample(args[0], args[1] === "position" ? "position" : "slot"));
      break;
    case "log":
      print(store.getLog(args[0], args[1] ? Number(args[1]) : 20));
      break;
    case "state":
      print(store.exportState(args[0]));
      break;
    case "demo":
      runDemo(store);
      break;
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  serve [--port=N]          启动 HTTP 服务（默认选择空闲端口）
  create <capacity> [seed]  创建抽样器
  append <id> <batchId> <记录...>  批量追加
  sample <id> [position]    查询样本（默认按槽位，可指定按原始位置展示）
  log <id> [limit]          查看最近替换解释
  state <id>                导出已保存状态
  demo                      运行演示`);
  }
}

main()
  .catch((err) => {
    console.error(err.code ? `${err.code}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.argv[2] !== "serve") store.close();
  });
