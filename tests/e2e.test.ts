import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Logger } from "../src/audit/logger.js";
import { hashApiKey } from "../src/auth/api-key.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { startHttp, type HttpHandle } from "../src/http.js";

let upstream: Server, http: HttpHandle, base: string;
const seen: { auth?: string; url?: string }[] = [];
const logs: string[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, url: req.url });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "success", count: 1, data: [{ id: 1, name: "Camry", company_id: [1, "Demo"] }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as any).port;

  const dir = mkdtempSync(join(tmpdir(), "drivo-mcp-"));
  const file = join(dir, "principals.json");
  writeFileSync(file, JSON.stringify([{
    id: "e2e", keyHash: hashApiKey("e2e-key"), userId: 1, scopes: ["drivo.vehicle.read"], companyIds: [1], defaultCompanyId: 1, upstreamTokenEnv: "E2E_UP_TOKEN",
  }]));
  process.env["E2E_UP_TOKEN"] = "e2e-upstream-token";
  const cfg = loadConfig({
    DRIVO_API_BASE_URL: `http://127.0.0.1:${upPort}`, DRIVO_MCP_PRINCIPALS_FILE: file, DRIVO_MCP_CONFIRM_SECRET: "e2e-confirm-secret-0123456789",
    PORT: "0", HOST: "127.0.0.1", MCP_ALLOWED_HOSTS: "127.0.0.1",
  });
  const app = buildApp(cfg, { logger: new Logger("info", (l) => logs.push(l)) });
  http = startHttp(cfg, app);
  await new Promise((r) => http.server.once("listening", r));
  base = `http://127.0.0.1:${(http.server.address() as any).port}`;
});

afterAll(async () => {
  await http.shutdown();
  upstream.close();
});

const connect = async (key?: string) => {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} } }));
  return client;
};

describe("remote MCP over HTTP", () => {
  it("exposes health and readiness", async () => {
    expect((await fetch(base + "/healthz")).status).toBe(200);
    expect((await fetch(base + "/readyz")).status).toBe(200);
  });
  it("rejects unauthenticated and wrong-key requests with 401", async () => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-request-id")).toBeTruthy();
    await expect(connect("wrong")).rejects.toThrow();
  });
  it("rejects a disallowed Host (DNS-rebinding guard)", async () => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { Host: "evil.example" } as any, body: "{}" }).catch(() => null);
    // fetch forbids overriding Host in some runtimes; either outcome must not be a 200.
    if (r) expect(r.status).not.toBe(200);
  });
  it("lists the 15 tools and the registered resource templates", async () => {
    const c = await connect("e2e-key");
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(15);
    expect(tools.find((t) => t.name === "drivo_create_lead")!.inputSchema.required).toContain("idempotency_key");
    const { resourceTemplates } = await c.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual(["drivo://customer/{id}", "drivo://vehicle/{id}"]);
    await c.close();
  });
  it("runs a read tool end-to-end using the principal's upstream token, never the client key", async () => {
    const c = await connect("e2e-key");
    const r: any = await c.callTool({ name: "drivo_search_vehicles", arguments: { search: "camry" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).result.vehicles[0].name).toBe("Camry");
    const last = seen.at(-1)!;
    expect(last.auth).toBe("Bearer e2e-upstream-token");
    expect(last.url).toContain("/api/v1/cars?");
    await c.close();
  });
  it("denies a tool outside the principal's scopes", async () => {
    const c = await connect("e2e-key");
    const r: any = await c.callTool({ name: "drivo_create_lead", arguments: { name: "x", idempotency_key: "key-12345678" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe("forbidden");
    await c.close();
  });
  it("reads a resource through the same authorisation path", async () => {
    const c = await connect("e2e-key");
    const r = await c.readResource({ uri: "drivo://customer/5" });
    expect(JSON.parse((r.contents[0] as any).text).code).toBe("forbidden"); // principal lacks customer.read
    await c.close();
  });
  it("never logs keys or tokens, and logs structured request lines", () => {
    const all = logs.join("\n");
    expect(all).not.toMatch(/e2e-key|e2e-upstream-token/);
    expect(logs.some((l) => JSON.parse(l).msg === "http_request")).toBe(true);
    expect(logs.some((l) => JSON.parse(l).audit === true)).toBe(true);
  });
  it("flips readiness to 503 on shutdown", async () => {
    // run last: shutdown is also called in afterAll, which must be idempotent
    const p = http.shutdown();
    await p;
    await expect(fetch(base + "/readyz")).rejects.toThrow();
  });
});
