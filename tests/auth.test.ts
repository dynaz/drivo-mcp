import { describe, expect, it } from "vitest";
import { PrincipalRegistry, extractKey, hashApiKey } from "../src/auth/api-key.js";
import { hasScope } from "../src/auth/permissions.js";
import { resolveCompany } from "../src/auth/company-scope.js";
import { searchVehicles } from "../src/tools/vehicles.js";
import { createLead } from "../src/tools/crm.js";
import { getPayments } from "../src/tools/finance.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { makeRuntime, principal } from "./helpers.js";

const entry = (over = {}) => ({
  id: "alice", keyHash: hashApiKey("alice-key"), userId: 1, scopes: ["drivo.vehicle.read"], companyIds: [1, 2], defaultCompanyId: 1,
  upstreamTokenEnv: "TOK_ALICE", ...over,
});

describe("authentication", () => {
  const reg = PrincipalRegistry.fromJson([entry()], { TOK_ALICE: "t" });
  it("accepts a valid key", () => expect(reg.authenticate("alice-key").id).toBe("alice"));
  it("rejects missing / wrong keys with 401", () => {
    expect(() => reg.authenticate(undefined)).toThrow(/Missing API key/);
    expect(() => reg.authenticate("nope")).toThrow(/Invalid API key/);
  });
  it("fails closed when the upstream token env var is unset, without naming it", () => {
    const r = PrincipalRegistry.fromJson([entry()], {});
    try { r.authenticate("alice-key"); throw new Error("no"); } catch (e: any) {
      expect(e.code).toBe("internal_error");
      expect(e.publicMessage).not.toMatch(/TOK_ALICE/);
    }
  });
  it("rejects malformed registry entries (plaintext key, default company outside allowlist)", () => {
    expect(() => PrincipalRegistry.fromJson([entry({ keyHash: "alice-key" })])).toThrow();
    expect(() => PrincipalRegistry.fromJson([entry({ defaultCompanyId: 9 })])).toThrow();
  });
  it("extracts Bearer and X-API-Key", () => {
    expect(extractKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractKey({ "x-api-key": "xyz" })).toBe("xyz");
    expect(extractKey({})).toBeUndefined();
  });
});

describe("permission denial", () => {
  it("drivo.admin implies every scope", () => expect(hasScope(["drivo.admin"], "drivo.finance.write")).toBe(true));
  it("denies a tool the principal lacks the scope for, without calling upstream", async () => {
    const { runtime, calls, events } = makeRuntime(() => ({ body: {} }));
    const r = await runtime.execute(getPayments, { deal_id: 1 }, principal({ scopes: ["drivo.vehicle.read"] }));
    expect(r.isError).toBe(true);
    expect(r.payload["code"]).toBe("forbidden");
    expect(calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ outcome: "denied", tool: "drivo_get_payments" });
  });
  it("read-only principal cannot write", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body: {} }));
    const r = await runtime.execute(createLead, { name: "x", idempotency_key: "key-12345678" }, principal({ scopes: ["drivo.crm.read"] }));
    expect(r.payload["code"]).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });
});

describe("tool surface", () => {
  it("exposes only the 15 domain tools and no generic ORM/SQL/shell tool", () => {
    const names = ALL_TOOLS.map((t) => t.name).sort();
    expect(names).toHaveLength(15);
    expect(names.every((n) => n.startsWith("drivo_"))).toBe(true);
    for (const bad of ["execute_kw", "unlink", "sql", "execute_python", "run_shell", "odoo_"]) {
      expect(names.some((n) => n.includes(bad))).toBe(false);
    }
  });
  it("every write tool requires an idempotency_key", () => {
    for (const t of ALL_TOOLS.filter((t) => t.write)) expect(Object.keys(t.fullShape)).toContain("idempotency_key");
  });
  it("company resolution honours the allowlist", () => {
    const p = principal({ companyIds: [1, 2], defaultCompanyId: 1 });
    expect(resolveCompany(p)).toBe(1);
    expect(resolveCompany(p, 2)).toBe(2);
    expect(() => resolveCompany(p, 3)).toThrow(/not authorised/);
  });
  it("search_vehicles scope is vehicle.read", () => expect(searchVehicles.scope).toBe("drivo.vehicle.read"));
});
