#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { createDrivoServer } from "./server.js";

async function main() {
  const cfg = loadConfig();
  const app = buildApp(cfg);

  if (cfg.MCP_TRANSPORT === "stdio") {
    const principal = app.registry.authenticate(cfg.DRIVO_MCP_API_KEY);
    const server = createDrivoServer(app.runtime, principal, randomUUID());
    await server.connect(new StdioServerTransport());
    app.logger.info("stdio_ready", { principal: principal.id });
    return;
  }

  const http = startHttp(cfg, app);
  const stop = (sig: string) => {
    app.logger.info("signal", { sig });
    http.shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => {
  // Config errors must not echo env values; zod messages name keys only.
  process.stderr.write(JSON.stringify({ level: "error", msg: "startup_failed", error: String(e?.message ?? e).slice(0, 500) }) + "\n");
  process.exit(1);
});
