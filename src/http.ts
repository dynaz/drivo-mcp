import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { extractKey } from "./auth/api-key.js";
import { DrivoMcpError, toSafeError } from "./errors/mcp-error.js";
import type { Config } from "./config.js";
import type { buildApp } from "./app.js";
import { createDrivoServer } from "./server.js";
import { InMemoryRateLimiter } from "./runtime/rate-limit.js";

type App = ReturnType<typeof buildApp>;
const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new DrivoMcpError("invalid_input", "Request body too large.", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(new DrivoMcpError("invalid_input", "Malformed JSON body.", 400));
      }
    });
    req.on("error", reject);
  });
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

export interface HttpHandle {
  server: Server;
  shutdown(): Promise<void>;
}

export function startHttp(cfg: Config, app: App): HttpHandle {
  let shuttingDown = false;
  let inflight = 0;
  const authLimiter = new InMemoryRateLimiter();

  const server = createServer(async (req, res) => {
    const inbound = req.headers["x-request-id"];
    const requestId = typeof inbound === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const started = Date.now();
    res.on("finish", () =>
      app.logger.info("http_request", { requestId, method: req.method, path: (req.url ?? "").split("?")[0], status: res.statusCode, durationMs: Date.now() - started }),
    );
    inflight++;
    try {
      const path = (req.url ?? "/").split("?")[0];

      if (path === "/healthz") return send(res, 200, { status: "ok" });
      if (path === "/readyz") {
        const ready = !shuttingDown && app.registry.size > 0;
        return send(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      }
      if (path !== "/mcp") return send(res, 404, { error: "not_found" });

      // DNS-rebinding / cross-origin protection
      const host = (req.headers.host ?? "").split(":")[0] ?? "";
      if (cfg.allowedHosts.length && !cfg.allowedHosts.includes(host)) throw new DrivoMcpError("forbidden", "Host not allowed.", 403);
      const origin = req.headers.origin;
      if (origin && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) throw new DrivoMcpError("forbidden", "Origin not allowed.", 403);

      if (req.method !== "POST") {
        return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null }, { Allow: "POST" });
      }
      if (shuttingDown) throw new DrivoMcpError("upstream_unavailable", "Server is shutting down.", 503);

      const ip = req.socket.remoteAddress ?? "?";
      const key = extractKey(req.headers);
      let principal;
      try {
        principal = app.registry.authenticate(key);
      } catch (e) {
        // throttle brute-force of API keys per source address
        if (!authLimiter.check(`ip:${ip}`, "read", 30).allowed) throw new DrivoMcpError("rate_limited", "Too many failed attempts.", 429);
        throw e;
      }

      const body = await readBody(req);
      const mcp = createDrivoServer(app.runtime, principal, requestId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const err = toSafeError(e);
      if (err.code === "internal_error") app.logger.error("http_error", { requestId, cause: String((err.cause as Error)?.message ?? err.cause) });
      if (!res.headersSent) {
        send(res, err.httpStatus, { error: err.code, message: err.publicMessage, request_id: requestId }, err.httpStatus === 401 ? { "WWW-Authenticate": 'Bearer realm="drivo-mcp"' } : {});
      }
    } finally {
      inflight--;
    }
  });

  server.listen(cfg.PORT, cfg.HOST, () => app.logger.info("listening", { host: cfg.HOST, port: cfg.PORT, principals: app.registry.size }));

  return {
    server,
    async shutdown() {
      shuttingDown = true; // readiness flips to 503 so the proxy drains us
      app.logger.info("shutdown_started", { inflight });
      await new Promise<void>((r) => server.close(() => r()));
      const deadline = Date.now() + 10_000;
      while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    },
  };
}
