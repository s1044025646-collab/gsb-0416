import { Store, ApiError } from "./store";
import * as fs from "node:fs";

const DB_PATH = process.env.DB_PATH ?? "data/reservoir.db";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    opts[key] = rest[i + 1];
  }
  return { cmd, opts };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function main(): void {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create": {
        const k = Number(opts.k);
        const seed = opts.seed !== undefined ? Number(opts.seed) : undefined;
        print(store.createSampler(k, seed));
        break;
      }
      case "append": {
        const records = opts.file
          ? (JSON.parse(fs.readFileSync(opts.file, "utf8")) as string[])
          : (opts.records ?? "").split(",");
        print(store.appendBatch(opts.id, opts["batch-id"], records));
        break;
      }
      case "sample": {
        const sort = opts.sort === "position" ? "position" : "slot";
        print(store.getSample(opts.id, sort));
        break;
      }
      case "log": {
        print(store.getLog(opts.id, opts.limit ? Number(opts.limit) : 50));
        break;
      }
      case "info": {
        print(store.getInfo(opts.id));
        break;
      }
      case "export": {
        const state = store.exportState(opts.id);
        if (opts.file) {
          fs.writeFileSync(opts.file, JSON.stringify(state, null, 2));
          console.log(`状态已导出到 ${opts.file}`);
        } else {
          print(state);
        }
        break;
      }
      case "import": {
        const state = JSON.parse(fs.readFileSync(opts.file, "utf8"));
        print(store.importState(state));
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令> [参数]
  create  --k 2 --seed 42
  append  --id <id> --batch-id b1 --records a,b,c   （或 --file records.json）
  sample  --id <id> [--sort slot|position]
  log     --id <id> [--limit 20]
  info    --id <id>
  export  --id <id> --file state.json
  import  --file state.json
数据目录: ${DB_PATH}（可用 DB_PATH 环境变量覆盖）`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    store.close();
  }
}

main();
