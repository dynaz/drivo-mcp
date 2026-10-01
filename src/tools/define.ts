import { z } from "zod";
import type { Principal } from "../auth/api-key.js";
import type { Scope } from "../auth/permissions.js";
import type { DrivoApiClient } from "../clients/drivo-api.js";

export interface ToolContext {
  principal: Principal;
  /** Company this call acts for (already checked against the allowlist). */
  companyId: number;
  requestId: string;
  api: DrivoApiClient;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  write: boolean;
  /** Needs a signed human confirmation step before it runs. */
  highRisk?: boolean;
  /** Tool-specific input. `company_id`, `idempotency_key`, `confirmation_token` are added by `defineTool`. */
  input: S;
  /** Returns data to show the model; for highRisk tools also `preview`. */
  handler: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
  /** highRisk only: human-readable summary shown at the confirmation step. */
  preview?: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown>;
}

export const id = (what: string) => z.number().int().positive().describe(what);
export const text = (what: string, max = 100) => z.string().trim().min(1).max(max).describe(what);
export const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").describe(what);
export const pageArgs = {
  limit: z.number().int().min(1).max(25).default(10).describe("Max rows (1-25, default 10)"),
  offset: z.number().int().min(0).max(10_000).default(0).describe("Rows to skip"),
};

/** Adds the cross-cutting inputs every Drivo tool shares. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> & { fullShape: z.ZodRawShape } {
  const extra: z.ZodRawShape = {
    company_id: z.number().int().positive().optional().describe("Company to act for. Defaults to your default company; must be one you are authorised for."),
  };
  if (def.write) {
    extra["idempotency_key"] = z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .describe("Unique key for this logical operation (e.g. a UUID). Retrying with the same key never duplicates the write.");
  }
  if (def.highRisk) {
    extra["confirmation_token"] = z
      .string()
      .max(2048)
      .optional()
      .describe("Omit on the first call to get a preview + token; send the same arguments with the token to execute.");
  }
  return { ...def, fullShape: { ...def.input, ...extra } };
}

/** Type-erased tool for registries/runtime (args were already validated against `fullShape`). */
export interface AnyTool {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  write: boolean;
  highRisk?: boolean;
  fullShape: z.ZodRawShape;
  handler: (ctx: ToolContext, args: any) => Promise<unknown>;
  preview?: (args: any) => Record<string, unknown>;
}

/** Pull a list out of a Drivo `data` payload that may be an array or an object wrapping one. */
export function rowsOf(data: unknown, key?: string): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (key && Array.isArray(o[key])) return o[key] as any[];
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as any[];
  }
  return [];
}
