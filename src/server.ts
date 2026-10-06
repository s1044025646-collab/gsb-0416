import * as http from "node:http";
import { Store } from "./store";
import { ApiError } from "./errors";
import { LIMITS } from "./limits";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
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
      if (size > LIMITS.MAX_BODY_BYTES) {
        reject(new ApiError("BAD_REQUEST", "请求体过大", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new ApiError("BAD_REQUEST", "请求体不是合法 JSON"));
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

      if (method === "GET" && url.pathname === "/") {
        return sendJson(res, 200, {
          service: "reservoir-sampling",
          limits: LIMITS,
          endpoints: [
            "POST /samplers {capacity, seed?}",
            "POST /samplers/:id/batches {batchId, records:[...]}",
            "GET  /samplers/:id/sample?sort=slot|position",
            "GET  /samplers/:id/log?limit=N",
            "GET  /samplers/:id/state",
          ],
        });
      }

      if (method === "POST" && parts.length === 1 && parts[0] === "samplers") {
        const body = (await readBody(req)) as { capacity?: number; seed?: number };
        return sendJson(res, 201, store.createSampler(Number(body.capacity), body.seed));
      }

      if (parts.length >= 2 && parts[0] === "samplers") {
        const id = parts[1];
        if (method === "POST" && parts.length === 3 && parts[2] === "batches") {
          const body = (await readBody(req)) as { batchId?: string; records?: string[] };
          return sendJson(res, 200, store.appendBatch(id, String(body.batchId ?? ""), body.records as string[]));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "sample") {
          const sort = url.searchParams.get("sort") === "position" ? "position" : "slot";
          return sendJson(res, 200, store.getSample(id, sort));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "log") {
          const limit = Number(url.searchParams.get("limit") ?? 20);
          return sendJson(res, 200, store.getLog(id, limit));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "state") {
          return sendJson(res, 200, store.exportState(id));
        }
      }

      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (err) {
      if (err instanceof ApiError) {
        return sendJson(res, err.httpStatus, { error: { code: err.code, message: err.message } });
      }
      sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}
