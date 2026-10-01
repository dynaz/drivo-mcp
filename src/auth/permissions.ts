import { DrivoMcpError } from "../errors/mcp-error.js";

export const SCOPES = [
  "drivo.vehicle.read",
  "drivo.customer.read",
  "drivo.crm.read",
  "drivo.crm.write",
  "drivo.sale.read",
  "drivo.sale.write",
  "drivo.finance.read",
  "drivo.finance.write",
  "drivo.service.read",
  "drivo.service.write",
  "drivo.admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(v: string): v is Scope {
  return (SCOPES as readonly string[]).includes(v);
}

/** drivo.admin implies every scope. It still never bypasses company scope. */
export function hasScope(granted: readonly Scope[], needed: Scope): boolean {
  return granted.includes("drivo.admin") || granted.includes(needed);
}

export function assertScope(granted: readonly Scope[], needed: Scope): void {
  if (!hasScope(granted, needed)) {
    throw new DrivoMcpError("forbidden", `Missing required scope: ${needed}`, 403);
  }
}
