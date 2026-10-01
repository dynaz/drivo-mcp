import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Principal } from "../auth/api-key.js";
import { assertScope, hasScope } from "../auth/permissions.js";
import { assertRecordInScope, filterList, resolveCompany } from "../auth/company-scope.js";
import type { AuditSink } from "../audit/logger.js";
import { Logger } from "../audit/logger.js";
import type { DrivoApiClient } from "../clients/drivo-api.js";
import { DrivoMcpError, toSafeError } from "../errors/mcp-error.js";
import type { AnyTool } from "../tools/define.js";
import { Confirmations } from "./confirmation.js";
import { fingerprint, type IdempotencyStore } from "./idempotency.js";
import type { RateLimiter } from "./rate-limit.js";

export interface RuntimeDeps {
  api: DrivoApiClient;
  logger: Logger;
  audit: AuditSink;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  confirmations: Confirmations;
  readLimitPerMinute: number;
  writeLimitPerMinute: number;
}

export interface ToolResult {
  isError: boolean;
  payload: Record<string, unknown>;
}

/** Internal-only figures are withheld unless the principal holds finance.read. */
const INTERNAL_KEY = /(^|_)(cost|costs|commission|commissions|margin|profit|landed|purchase_price|vendor_price)(_|$)/i;

export function stripInternal(v: unknown, allow: boolean): unknown {
  if (allow) return v;
  if (Array.isArray(v)) return v.map((x) => stripInternal(x, allow));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !INTERNAL_KEY.test(k))
        .map(([k, x]) => [k, stripInternal(x, allow)]),
    );
  }
  return v;
}

/** Recursively apply company isolation to every record-array / record in a result. */
function enforceCompany(v: unknown, allowed: readonly number[], active: number): unknown {
  if (Array.isArray(v)) {
    return filterList(v, allowed, active).rows.map((r) => enforceCompany(r, allowed, active));
  }
  if (v && typeof v === "object") {
    assertRecordInScope(v, allowed, active);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enforceCompany(x, allowed, active)]));
  }
  return v;
}

export class ToolRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  async execute(tool: AnyTool, rawArgs: unknown, principal: Principal, requestId: string = randomUUID()): Promise<ToolResult> {
    const started = Date.now();
    const d = this.deps;
    let companyId = principal.defaultCompanyId;
    let idemKey: string | undefined;
    let auditInput: unknown = {};
    let audited = false;
    const done = (outcome: Parameters<AuditSink["record"]>[0]["outcome"], errorCode?: string) => {
      audited = true;
      d.audit.record({
        requestId,
        tool: tool.name,
        principalId: principal.id,
        userId: principal.userId,
        companyId,
        write: tool.write,
        outcome,
        errorCode,
        durationMs: Date.now() - started,
        idempotencyKey: idemKey,
        input: auditInput,
      });
    };

    try {
      // 1. authorisation
      try {
        assertScope(principal.scopes, tool.scope);
      } catch (e) {
        auditInput = rawArgs;
        done("denied", "forbidden");
        throw e;
      }

      // 2. validation
      const parsed = z.object(tool.fullShape).strict().safeParse(rawArgs ?? {});
      auditInput = rawArgs;
      if (!parsed.success) {
        done("invalid", "invalid_input");
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        throw new DrivoMcpError("invalid_input", `Invalid input — ${msg}`, 400);
      }
      const args = parsed.data as Record<string, any>;
      auditInput = args;
      idemKey = args["idempotency_key"];

      // 3. company scope
      try {
        companyId = resolveCompany(principal, args["company_id"]);
      } catch (e) {
        done("denied", "company_forbidden");
        throw e;
      }

      // 4. rate limit
      const limit = tool.write ? d.writeLimitPerMinute : (principal.rateLimitPerMinute ?? d.readLimitPerMinute);
      const rl = d.rateLimiter.check(principal.id, tool.write ? "write" : "read", limit);
      if (!rl.allowed) {
        done("rate_limited", "rate_limited");
        throw new DrivoMcpError("rate_limited", `Rate limit exceeded. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`, 429, undefined, {
          retryAfterMs: rl.retryAfterMs,
        });
      }

      const { company_id: _c, idempotency_key: _i, confirmation_token: token, ...toolArgs } = args;
      const ctx = { principal, companyId, requestId, api: d.api };
      const run = async () => tool.handler(ctx, toolArgs as never);

      // 5. high-risk confirmation (bound to the exact arguments incl. idempotency_key)
      if (tool.highRisk) {
        const bound = { ...toolArgs, idempotency_key: idemKey, company_id: companyId };
        if (!token) {
          const { token: t, expiresAt } = d.confirmations.issue(principal.id, tool.name, bound);
          done("confirmation_required");
          return {
            isError: false,
            payload: {
              status: "confirmation_required",
              message: "High-risk operation. Show this preview to the user. To proceed, call the tool again with the same arguments plus confirmation_token.",
              preview: tool.preview ? tool.preview(toolArgs as never) : toolArgs,
              confirmation_token: t,
              expires_at: expiresAt,
            },
          };
        }
        try {
          d.confirmations.verify(token, principal.id, tool.name, bound);
        } catch (e) {
          done("denied", "confirmation_invalid");
          throw e;
        }
      }

      // 6. idempotency for writes, then the handler
      let result: unknown;
      let replayed = false;
      if (tool.write) {
        const r = await d.idempotency.execute(`${principal.id}:${companyId}:${tool.name}`, idemKey!, fingerprint(toolArgs), run);
        result = r.result;
        replayed = r.replayed;
      } else {
        result = await run();
      }

      // 7. output hygiene: company isolation + internal-figure stripping
      const safe = stripInternal(enforceCompany(result, principal.companyIds, companyId), hasScope(principal.scopes, "drivo.finance.read"));
      done(replayed ? "replayed" : "ok");
      return { isError: false, payload: { status: "ok", request_id: requestId, ...(replayed ? { replayed: true } : {}), result: safe } };
    } catch (e) {
      const err = toSafeError(e);
      if (err.code === "internal_error" || err.code.startsWith("upstream")) {
        d.logger.error("tool_failed", { tool: tool.name, requestId, code: err.code, cause: String((err.cause as Error)?.message ?? err.cause ?? "") });
      }
      if (!audited) done("error", err.code);
      return {
        isError: true,
        payload: { status: "error", code: err.code, message: err.publicMessage, request_id: requestId, ...(err.details ?? {}) },
      };
    }
  }
}
