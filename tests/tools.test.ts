import { describe, expect, it } from "vitest";
import { createBooking } from "../src/tools/bookings.js";
import { createLead, getLead, searchLeads } from "../src/tools/crm.js";
import { getCustomer, searchCustomers } from "../src/tools/customers.js";
import { attentionCenter, dashboardKpis } from "../src/tools/dashboard.js";
import { getDeal, searchDeals } from "../src/tools/deals.js";
import { getPayments } from "../src/tools/finance.js";
import { createServiceBooking, getServiceHistory } from "../src/tools/service.js";
import { getVehicle, searchVehicles } from "../src/tools/vehicles.js";
import { makeRuntime, principal, UPSTREAM_TOKEN } from "./helpers.js";

const ok = (data: unknown, extra = {}) => ({ body: { status: "success", data, ...extra } });

describe("read tools", () => {
  it("search_vehicles maps filters to /api/v1/cars with the upstream bearer", async () => {
    const { runtime, calls } = makeRuntime(() => ok([{ id: 1, name: "Camry" }], { count: 1 }));
    const r = await runtime.execute(searchVehicles, { search: "camry", year_min: 2020 }, principal());
    expect(r.payload).toMatchObject({ status: "ok", result: { count: 1, vehicles: [{ id: 1 }] } });
    expect(calls[0]!.url.pathname).toBe("/api/v1/cars");
    expect(calls[0]!.url.searchParams.get("search")).toBe("camry");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("10");
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(calls[0]!.headers["X-Request-Id"]).toBeTruthy();
  });
  it.each([
    [getVehicle, { vehicle_id: 5 }, "/api/v1/cars/5"],
    [getCustomer, { customer_id: 6 }, "/api/v1/customers/6"],
    [getLead, { lead_id: 7 }, "/api/v1/leads/7"],
    [getDeal, { deal_id: 8 }, "/api/v1/deals/8"],
    [searchCustomers, { search: "somchai" }, "/api/v1/customers"],
    [searchLeads, {}, "/api/v1/leads"],
    [searchDeals, {}, "/api/v1/car-bookings"],
    [getServiceHistory, { customer_id: 9 }, "/api/v1/customers/9/service-history"],
    [dashboardKpis, {}, "/api/v1/dashboard"],
    [attentionCenter, {}, "/api/v1/attention"],
  ])("%# hits the right Drivo route", async (tool, args, path) => {
    const { runtime, calls } = makeRuntime(() => ok({ id: 1 }));
    const r = await runtime.execute(tool as never, args, principal());
    expect(r.isError).toBe(false);
    expect(calls[0]!.url.pathname).toBe(path);
  });
  it("get_payments needs exactly one of deal_id / invoice_id", async () => {
    const { runtime } = makeRuntime(() => ok({}));
    expect((await runtime.execute(getPayments, {}, principal())).payload["code"]).toBe("invalid_input");
    expect((await runtime.execute(getPayments, { deal_id: 1, invoice_id: 2 }, principal())).payload["code"]).toBe("invalid_input");
    expect((await runtime.execute(getPayments, { deal_id: 1 }, principal())).isError).toBe(false);
  });
  it("withholds internal cost/profit fields without finance.read", async () => {
    const { runtime } = makeRuntime(() => ok({ id: 1, list_price: 900000, purchase_cost: 700000, landed_cost: 1, gross_profit: 5 }));
    const lean = principal({ scopes: ["drivo.vehicle.read"] });
    const r = await runtime.execute(getVehicle, { vehicle_id: 1 }, lean);
    expect(JSON.stringify(r.payload)).not.toMatch(/purchase_cost|landed_cost|gross_profit/);
    expect(JSON.stringify(r.payload)).toMatch(/list_price/);
    const full = await runtime.execute(getVehicle, { vehicle_id: 1 }, principal());
    expect(JSON.stringify(full.payload)).toMatch(/purchase_cost/);
  });
});

describe("write tools", () => {
  it("create_lead posts a JSON-RPC envelope with mapped fields", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body: { jsonrpc: "2.0", id: null, result: { status: "success", data: { id: 77, name: "L" } } } }));
    const r = await runtime.execute(createLead, { name: "L", email: "a@b.co", vehicle_variant_id: 3, idempotency_key: "key-0000001" }, principal());
    expect(r.payload).toMatchObject({ status: "ok", result: { lead: { id: 77 } } });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body.params).toMatchObject({ name: "L", email_from: "a@b.co", car_booking_id: 3 });
  });
  it("create_service_booking maps fields", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body: { result: { status: "success", data: { id: 5 } } } }));
    await runtime.execute(createServiceBooking, { customer_id: 1, vehicle_id: 2, deal_id: 3, idempotency_key: "key-0000002" }, principal());
    expect(calls[0]!.body.params).toMatchObject({ service_customer_id: 1, service_product_id: 2, car_booking_id: 3 });
  });
  it("write without idempotency_key is rejected", async () => {
    const { runtime, calls } = makeRuntime(() => ok({}));
    const r = await runtime.execute(createLead, { name: "x" }, principal());
    expect(r.payload["code"]).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

describe("high-risk confirmation (create_booking)", () => {
  const args = { vehicle_variant_id: 1, customer_id: 2, booking_date: "2026-10-05", agreed_price: 500000, idempotency_key: "booking-key-1" };
  const upstream = () => ({ body: { result: { status: "success", data: { id: 9, name: "BK/1" } } } });

  it("step 1 returns a preview + token and does NOT call Drivo", async () => {
    const { runtime, calls } = makeRuntime(upstream);
    const r = await runtime.execute(createBooking, args, principal());
    expect(r.payload["status"]).toBe("confirmation_required");
    expect(r.payload["confirmation_token"]).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it("step 2 with the token executes", async () => {
    const { runtime, calls } = makeRuntime(upstream);
    const t = (await runtime.execute(createBooking, args, principal())).payload["confirmation_token"] as string;
    const r = await runtime.execute(createBooking, { ...args, confirmation_token: t }, principal());
    expect(r.payload).toMatchObject({ status: "ok", result: { booking: { id: 9 } } });
    expect(calls).toHaveLength(1);
  });
  it("a changed argument invalidates the token", async () => {
    const { runtime, calls } = makeRuntime(upstream);
    const t = (await runtime.execute(createBooking, args, principal())).payload["confirmation_token"] as string;
    const r = await runtime.execute(createBooking, { ...args, agreed_price: 1, confirmation_token: t }, principal());
    expect(r.payload["code"]).toBe("confirmation_invalid");
    expect(calls).toHaveLength(0);
  });
  it("a token cannot be used by another principal, nor forged, nor after expiry", async () => {
    let now = 1_000_000;
    const { runtime } = makeRuntime(upstream, { now: () => now });
    const t = (await runtime.execute(createBooking, args, principal())).payload["confirmation_token"] as string;
    const other = principal({ id: "p2" });
    expect((await runtime.execute(createBooking, { ...args, confirmation_token: t }, other)).payload["code"]).toBe("confirmation_invalid");
    expect((await runtime.execute(createBooking, { ...args, confirmation_token: t + "x" }, principal())).payload["code"]).toBe("confirmation_invalid");
    now += 6 * 60_000;
    expect((await runtime.execute(createBooking, { ...args, confirmation_token: t }, principal())).payload["code"]).toBe("confirmation_invalid");
  });
});

describe("idempotency", () => {
  const body = { result: { status: "success", data: { id: 1 } } };
  it("same key + same args executes once and replays", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body }));
    const a = { name: "L", idempotency_key: "idem-key-1" };
    const r1 = await runtime.execute(createLead, a, principal());
    const r2 = await runtime.execute(createLead, a, principal());
    expect(calls).toHaveLength(1);
    expect(r2.payload["replayed"]).toBe(true);
    expect(r2.payload["result"]).toEqual(r1.payload["result"]);
  });
  it("concurrent duplicates execute once", async () => {
    const { runtime, calls } = makeRuntime(async () => { await new Promise((r) => setTimeout(r, 20)); return { body }; });
    const a = { name: "L", idempotency_key: "idem-key-2" };
    await Promise.all([runtime.execute(createLead, a, principal()), runtime.execute(createLead, a, principal())]);
    expect(calls).toHaveLength(1);
  });
  it("same key with different args is a conflict", async () => {
    const { runtime } = makeRuntime(() => ({ body }));
    await runtime.execute(createLead, { name: "A", idempotency_key: "idem-key-3" }, principal());
    const r = await runtime.execute(createLead, { name: "B", idempotency_key: "idem-key-3" }, principal());
    expect(r.payload["code"]).toBe("idempotency_conflict");
  });
  it("keys are scoped per principal", async () => {
    const { runtime, calls } = makeRuntime(() => ({ body }));
    const a = { name: "A", idempotency_key: "idem-key-4" };
    await runtime.execute(createLead, a, principal({ id: "p1" }));
    await runtime.execute(createLead, a, principal({ id: "p2" }));
    expect(calls).toHaveLength(2);
  });
  it("a failed write is not cached; retry hits Drivo again", async () => {
    let n = 0;
    const { runtime, calls } = makeRuntime(() => (++n === 1 ? { status: 500, body: {} } : { body }));
    const a = { name: "A", idempotency_key: "idem-key-5" };
    expect((await runtime.execute(createLead, a, principal())).isError).toBe(true);
    expect((await runtime.execute(createLead, a, principal())).isError).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
