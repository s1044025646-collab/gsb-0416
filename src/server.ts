import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Store, ApiError } from "./store";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError("BODY_TOO_LARGE", "请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "POST" && parts.length === 1 && parts[0] === "samplers") {
        const body = (await readBody(req)) as { k?: number; seed?: number };
        send(res, 201, store.createSampler(body.k as number, body.seed));
        return;
      }
      if (parts.length >= 2 && parts[0] === "samplers") {
        const id = parts[1];
        if (method === "GET" && parts.length === 2) return send(res, 200, store.getInfo(id));
        if (method === "POST" && parts.length === 3 && parts[2] === "batches") {
          const body = (await readBody(req)) as { batchId?: string; records?: string[] };
          return send(res, 200, store.appendBatch(id, body.batchId, body.records));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "sample") {
          const sort = url.searchParams.get("sort") === "position" ? "position" : "slot";
          return send(res, 200, store.getSample(id, sort));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "log") {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          return send(res, 200, { entries: store.getLog(id, Number.isInteger(limit) ? limit : 50) });
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "state") {
          return send(res, 200, store.exportState(id));
        }
      }
      if (method === "POST" && parts.length === 1 && parts[0] === "import") {
        const body = await readBody(req);
        return send(res, 201, store.importState(body));
      }
      throw new ApiError("NOT_FOUND", "路由不存在", 404);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
      }
    }
  });
}

export function startServer(dbPath: string, port = 0): Promise<{ server: http.Server; port: number }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  const dbPath = process.env.DB_PATH ?? "data/reservoir.db";
  startServer(dbPath, port).then(({ port: p }) => {
    console.log(`蓄水池抽样服务已启动: http://127.0.0.1:${p} (数据库: ${dbPath})`);
  });
}
