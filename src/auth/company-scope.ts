import { DrivoMcpError } from "../errors/mcp-error.js";
import type { Principal } from "./api-key.js";

/**
 * Resolve the company a call acts for. A caller may only name a company in
 * its allowlist; anything else is refused (never silently widened/narrowed).
 */
export function resolveCompany(p: Principal, requested?: number): number {
  const id = requested ?? p.defaultCompanyId;
  if (!p.companyIds.includes(id)) {
    throw new DrivoMcpError("company_forbidden", "You are not authorised for the requested company.", 403);
  }
  return id;
}

function companyIdOf(rec: Record<string, unknown>): number | null | undefined {
  const c = rec["company_id"];
  if (c === undefined) return undefined; // field not present: nothing to check
  if (c === null || c === false) return null;
  if (typeof c === "number") return c;
  if (Array.isArray(c) && typeof c[0] === "number") return c[0];
  if (typeof c === "object" && c && typeof (c as { id?: unknown }).id === "number") return (c as { id: number }).id;
  return Number.NaN; // unrecognised shape: treat as foreign (fail closed)
}

/**
 * Defence in depth on top of Drivo's own RBAC: drop (list) or deny (single)
 * any record that carries a company_id outside the principal's allowlist and
 * outside the requested company. Records with no company_id pass through
 * (Drivo already scoped them server-side by the bearer token's user).
 */
export function inScope(rec: unknown, allowed: readonly number[], active: number): boolean {
  if (!rec || typeof rec !== "object") return true;
  const cid = companyIdOf(rec as Record<string, unknown>);
  if (cid === undefined || cid === null) return true;
  return allowed.includes(cid) && cid === active;
}

export function filterList<T>(rows: T[], allowed: readonly number[], active: number): { rows: T[]; dropped: number } {
  const kept = rows.filter((r) => inScope(r, allowed, active));
  return { rows: kept, dropped: rows.length - kept.length };
}

export function assertRecordInScope(rec: unknown, allowed: readonly number[], active: number): void {
  if (!inScope(rec, allowed, active)) {
    // Same message as a miss so existence in another company is not revealed.
    throw new DrivoMcpError("not_found", "Record not found.", 404);
  }
}
