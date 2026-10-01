import { describe, expect, it } from "vitest";
import { redact } from "../src/audit/logger.js";
import { createLead } from "../src/tools/crm.js";
import { getCustomer } from "../src/tools/customers.js";
import { searchLeads } from "../src/tools/crm.js";
import { getVehicle, searchVehicles } from "../src/tools/vehicles.js";
import { makeRuntime, principal, UPSTREAM_TOKEN } from "./helpers.js";

const ok = (data: unknown) => ({ body: { status: "success", data } });

describe("company isolation", () => {
  it("refuses a company outside the allowlist and never calls Drivo", async () => {
    const { runtime, calls, events } = makeRuntime(() => ok([]));
    const r = await runtime.execute(searchVehicles, { company_id: 2 }, principal({ companyIds: [1] }));
    expect(r.payload["code"]).toBe("company_forbidden");
    expect(calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ outcome: "denied", errorCode: "company_forbidden" });
  });
  it("drops foreign-company rows even if upstream returns them", async () => {
    const rows = [{ id: 1, company_id: [1, "A"] }, { id: 2, company_id: [2, "B"] }, { id: 3, company_id: 99 }, { id: 4 }];
    const { runtime } = makeRuntime(() => ok(rows));
    const r = await runtime.execute(searchLeads, {}, principal({ companyIds: [1, 2], defaultCompanyId: 1 }));
    const ids = (r.payload["result"] as any).leads.map((x: any) => x.id);
    expect(ids).toEqual([1, 4]); // 2 is allowed but not the ACTIVE company; 3 is foreign
  });
  it("a single foreign record is reported as not_found (existence not leaked)", async () => {
    const { runtime } = makeRuntime(() => ok({ id: 5, name: "X", company_id: [2, "Other Dealer"] }));
    const r = await runtime.execute(getCustomer, { customer_id: 5 }, principal({ companyIds: [1] }));
    expect(r.payload["code"]).toBe("not_found");
    expect(JSON.stringify(r.payload)).not.toMatch(/Other Dealer/);
  });
  it("foreign company nested inside a record is also blocked, and unknown shapes fail closed", async () => {
    const { runtime } = makeRuntime(() => ok({ id: 1, company_id: [1, "A"], owner: { company_id: [2, "B"] } }));
    expect((await runtime.execute(getVehicle, { vehicle_id: 1 }, principal())).payload["code"]).toBe("not_found");
    const { runtime: r2 } = makeRuntime(() => ok({ id: 1, company_id: "weird" }));
    expect((await r2.execute(getVehicle, { vehicle_id: 1 }, principal())).payload["code"]).toBe("not_found");
  });
  it("idempotency is partitioned by company", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body: { result: { status: "success", data: { id: 1 } } } }));
    const p = principal({ companyIds: [1, 2] });
    await runtime.execute(createLead, { name: "A", idempotency_key: "idem-co-key1", company_id: 1 }, p);
    await runtime.execute(createLead, { name: "A", idempotency_key: "idem-co-key1", company_id: 2 }, p);
    expect(calls).toHaveLength(2);
  });
});

describe("invalid inputs", () => {
  const cases: [string, any, unknown][] = [
    ["negative id", getVehicle, { vehicle_id: -1 }],
    ["string id", getVehicle, { vehicle_id: "1; DROP TABLE" }],
    ["float id", getVehicle, { vehicle_id: 1.5 }],
    ["limit too big", searchVehicles, { limit: 5000 }],
    ["unknown argument", searchVehicles, { search: "x", domain: "[]" }],
    ["bad email", createLead, { name: "x", email: "nope", idempotency_key: "key-12345678" }],
    ["bad key chars", createLead, { name: "x", idempotency_key: "bad key!!!!" }],
    ["empty search", searchVehicles, { search: "   " }],
    ["bad priority", createLead, { name: "x", priority: "9", idempotency_key: "key-12345678" }],
  ];
  it.each(cases)("%s -> invalid_input, no upstream call", async (_n, tool, args) => {
    const { runtime, calls } = makeRuntime(() => ok({}));
    const r = await runtime.execute(tool, args, principal());
    expect(r.payload["code"]).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

describe("API failure / timeouts", () => {
  it("5xx becomes a generic upstream_error with no upstream body leaked", async () => {
    const { runtime } = makeRuntime(() => ({ status: 500, body: { message: "psycopg2.errors.UndefinedTable password=hunter2 " + UPSTREAM_TOKEN } }));
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    expect(r.payload["code"]).toBe("upstream_error");
    const s = JSON.stringify(r.payload);
    expect(s).not.toMatch(/psycopg|hunter2/);
    expect(s).not.toContain(UPSTREAM_TOKEN);
  });
  it("upstream 401 is not blamed on the user", async () => {
    const { runtime } = makeRuntime(() => ({ status: 401, body: {} }));
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    expect(r.payload["code"]).toBe("upstream_error");
  });
  it("404 and 403 map cleanly", async () => {
    expect((await makeRuntime(() => ({ status: 404, body: {} })).runtime.execute(getVehicle, { vehicle_id: 1 }, principal())).payload["code"]).toBe("not_found");
    expect((await makeRuntime(() => ({ status: 403, body: {} })).runtime.execute(getVehicle, { vehicle_id: 1 }, principal())).payload["code"]).toBe("forbidden");
  });
  it("a business error from Drivo is passed on; a leaky one is not", async () => {
    const a = makeRuntime(() => ({ body: { result: { status: "error", message: "Vehicle already sold" } } }));
    expect((await a.runtime.execute(createLead, { name: "x", idempotency_key: "key-12345678" }, principal())).payload["message"]).toBe("Vehicle already sold");
    const b = makeRuntime(() => ({ body: { result: { status: "error", message: 'Traceback (most recent call last):\n File "x.py"' } } }));
    expect((await b.runtime.execute(createLead, { name: "x", idempotency_key: "key-12345678" }, principal())).payload["message"]).not.toMatch(/Traceback/);
  });
  it("network failure -> upstream_unavailable", async () => {
    const { runtime } = makeRuntime(() => ({}), { fetchImpl: (async () => { throw new TypeError("ECONNREFUSED 10.0.0.5:5432"); }) as never });
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    expect(r.payload["code"]).toBe("upstream_unavailable");
    expect(JSON.stringify(r.payload)).not.toMatch(/ECONNREFUSED|5432/);
  });
  it("hung upstream times out", async () => {
    const hang = ((_u: unknown, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as never;
    const { runtime } = makeRuntime(() => ({}), { timeoutMs: 30, fetchImpl: hang });
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    expect(r.payload["code"]).toBe("upstream_timeout");
  });
  it("writes are never retried", async () => {
    const { runtime, calls } = makeRuntime(() => ({ status: 503, body: {} }));
    await runtime.execute(createLead, { name: "x", idempotency_key: "key-12345678" }, principal());
    expect(calls).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("blocks after the per-minute budget, then recovers in the next window", async () => {
    let now = 0;
    const { runtime, events } = makeRuntime(() => ok([]), { readLimit: 2, now: () => now });
    const run = () => runtime.execute(searchVehicles, {}, principal());
    expect((await run()).isError).toBe(false);
    expect((await run()).isError).toBe(false);
    const r = await run();
    expect(r.payload["code"]).toBe("rate_limited");
    expect(r.payload["retryAfterMs"]).toBeGreaterThan(0);
    expect(events.at(-1)?.outcome).toBe("rate_limited");
    now += 61_000;
    expect((await run()).isError).toBe(false);
  });
  it("write budget is separate from read budget and per principal", async () => {
    const { runtime } = makeRuntime(() => ({ body: { result: { status: "success", data: { id: 1 } } } }), { writeLimit: 1, readLimit: 50 });
    const w = (k: string, p = "p1") => runtime.execute(createLead, { name: k, idempotency_key: "key-" + k.padEnd(8, "x") }, principal({ id: p }));
    expect((await w("a")).isError).toBe(false);
    expect((await w("b")).payload["code"]).toBe("rate_limited");
    expect((await w("c", "p2")).isError).toBe(false);
    expect((await runtime.execute(searchVehicles, {}, principal())).isError).toBe(false);
  });
});

describe("secret leakage + audit logging", () => {
  it("redact() masks secret keys and bearer/JWT-shaped values", () => {
    const out = JSON.stringify(redact({ authorization: "Bearer abcdefgh12345", nested: { api_key: "k", note: "tok Bearer abcdefghij123 end" }, ok: "fine" }));
    expect(out).not.toMatch(/abcdefgh12345|abcdefghij123/);
    expect(out).toContain("fine");
  });
  it("upstream token never appears in results, audit events or logs, even on failure", async () => {
    const { runtime, events, logs } = makeRuntime(() => ({ status: 500, body: { echo: UPSTREAM_TOKEN } }));
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    const ok = makeRuntime(() => ok_(UPSTREAM_TOKEN));
    const r2 = await ok.runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    for (const blob of [JSON.stringify(r), JSON.stringify(events), logs.join("\n"), JSON.stringify(ok.events), ok.logs.join("\n")]) {
      expect(blob).not.toContain(UPSTREAM_TOKEN);
    }
    void r2;
  });
  it("writes one audit event per call with request id, principal, company, outcome, duration", async () => {
    const { runtime, events } = makeRuntime(() => ({ body: { result: { status: "success", data: { id: 1 } } } }));
    await runtime.execute(createLead, { name: "A", idempotency_key: "audit-key-1" }, principal(), "req-12345678");
    await runtime.execute(createLead, { name: "A", idempotency_key: "audit-key-1" }, principal(), "req-87654321");
    await runtime.execute(searchVehicles, { limit: 0 }, principal(), "req-bad00000");
    expect(events.map((e) => e.outcome)).toEqual(["ok", "replayed", "invalid"]);
    expect(events[0]).toMatchObject({ requestId: "req-12345678", principalId: "p1", userId: 7, companyId: 1, write: true, tool: "drivo_create_lead", idempotencyKey: "audit-key-1" });
    expect(typeof events[0]!.durationMs).toBe("number");
    expect(events.every((e) => e.requestId)).toBe(true);
  });
  it("audit input is redacted at the sink", async () => {
    const { Logger, LogAuditSink } = await import("../src/audit/logger.js");
    const lines: string[] = [];
    const sink = new LogAuditSink(new Logger("info", (l) => lines.push(l)));
    sink.record({ requestId: "r", tool: "t", principalId: "p", userId: 1, companyId: 1, write: false, outcome: "ok", durationMs: 1, input: { api_key: "SEKRIT", long: "x".repeat(500) } });
    expect(lines[0]).not.toContain("SEKRIT");
    expect(lines[0]!.length).toBeLessThan(700);
  });
});

const ok_ = (token: string) => ({ body: { status: "success", data: { id: 1, note: "fine", unrelated: token.length } } });
