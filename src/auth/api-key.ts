import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DrivoMcpError } from "../errors/mcp-error.js";
import { SCOPES, type Scope } from "./permissions.js";

/** An authenticated caller. `upstreamToken` is the Drivo bearer for that user. */
export interface Principal {
  id: string;
  userId: number;
  scopes: Scope[];
  companyIds: number[];
  defaultCompanyId: number;
  upstreamToken: string;
  rateLimitPerMinute?: number;
}

const PrincipalConfig = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    keyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "keyHash must be sha256:<64 hex>"),
    userId: z.number().int().positive(),
    scopes: z.array(z.enum(SCOPES)).min(1),
    companyIds: z.array(z.number().int().positive()).min(1),
    defaultCompanyId: z.number().int().positive(),
    upstreamTokenEnv: z.string().min(1),
    rateLimitPerMinute: z.number().int().positive().optional(),
  })
  .refine((p) => p.companyIds.includes(p.defaultCompanyId), {
    message: "defaultCompanyId must be in companyIds",
  });

export type PrincipalConfigEntry = z.infer<typeof PrincipalConfig>;

export const hashApiKey = (key: string): string =>
  "sha256:" + createHash("sha256").update(key).digest("hex");

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class PrincipalRegistry {
  constructor(
    private readonly entries: PrincipalConfigEntry[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  static fromFile(path: string, env: NodeJS.ProcessEnv = process.env): PrincipalRegistry {
    return PrincipalRegistry.fromJson(JSON.parse(readFileSync(path, "utf8")), env);
  }

  static fromJson(raw: unknown, env: NodeJS.ProcessEnv = process.env): PrincipalRegistry {
    return new PrincipalRegistry(z.array(PrincipalConfig).parse(raw), env);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Constant-time lookup: every entry is compared, no early exit on match. */
  authenticate(presentedKey: string | undefined): Principal {
    if (!presentedKey) throw new DrivoMcpError("unauthenticated", "Missing API key.", 401);
    const presented = hashApiKey(presentedKey);
    let match: PrincipalConfigEntry | undefined;
    for (const e of this.entries) {
      if (safeEqualHex(presented, e.keyHash)) match = e;
    }
    if (!match) throw new DrivoMcpError("unauthenticated", "Invalid API key.", 401);
    const upstreamToken = this.env[match.upstreamTokenEnv];
    if (!upstreamToken) {
      // Operator misconfiguration: log-worthy, but never name the variable to the client.
      throw new DrivoMcpError("internal_error", "Principal is not fully configured.", 500);
    }
    return {
      id: match.id,
      userId: match.userId,
      scopes: match.scopes,
      companyIds: match.companyIds,
      defaultCompanyId: match.defaultCompanyId,
      upstreamToken,
      rateLimitPerMinute: match.rateLimitPerMinute,
    };
  }
}

/** Extract a key from `Authorization: Bearer` or `X-API-Key`. */
export function extractKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers["authorization"];
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, "").trim() || undefined;
  const x = headers["x-api-key"];
  return (Array.isArray(x) ? x[0] : x) || undefined;
}
