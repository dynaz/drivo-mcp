import { Logger, type AuditEvent, type AuditSink } from "../src/audit/logger.js";
import type { Principal } from "../src/auth/api-key.js";
import { DrivoApiClient } from "../src/clients/drivo-api.js";
import { Confirmations } from "../src/runtime/confirmation.js";
import { ToolRuntime } from "../src/runtime/executor.js";
import { InMemoryIdempotencyStore } from "../src/runtime/idempotency.js";
import { InMemoryRateLimiter } from "../src/runtime/rate-limit.js";
import type { Scope } from "../src/auth/permissions.js";

export const UPSTREAM_TOKEN = "upstream-token-SECRET-123456";

export interface Call { method: string; url: URL; headers: Record<string, string>; body?: any }
export type Responder = (c: Call) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

export function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input.toString()),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const r = await responder(call);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const principal = (over: Partial<Principal> = {}): Principal => ({
  id: "p1",
  userId: 7,
  scopes: ["drivo.vehicle.read", "drivo.customer.read", "drivo.crm.read", "drivo.crm.write", "drivo.sale.read", "drivo.sale.write", "drivo.service.read", "drivo.service.write", "drivo.finance.read"],
  companyIds: [1],
  defaultCompanyId: 1,
  upstreamToken: UPSTREAM_TOKEN,
  ...over,
});

export function makeRuntime(responder: Responder, opts: { timeoutMs?: number; readLimit?: number; writeLimit?: number; now?: () => number; fetchImpl?: typeof fetch } = {}) {
  const f = fakeFetch(responder);
  const events: AuditEvent[] = [];
  const logs: string[] = [];
  const audit: AuditSink = { record: (e) => events.push(e) };
  const logger = new Logger("debug", (l) => logs.push(l));
  const api = new DrivoApiClient({ baseUrl: "https://drivo.test", timeoutMs: opts.timeoutMs ?? 1000, fetch: opts.fetchImpl ?? f.fetch, logger, getRetries: 0 });
  const runtime = new ToolRuntime({
    api, logger, audit,
    rateLimiter: new InMemoryRateLimiter(opts.now),
    idempotency: new InMemoryIdempotencyStore(undefined, opts.now),
    confirmations: new Confirmations("test-confirm-secret-0123456789", undefined, opts.now),
    readLimitPerMinute: opts.readLimit ?? 100,
    writeLimitPerMinute: opts.writeLimit ?? 100,
  });
  return { runtime, calls: f.calls, events, logs };
}
