import { createHash } from "node:crypto";
import { DrivoMcpError } from "../errors/mcp-error.js";

export const fingerprint = (v: unknown): string =>
  createHash("sha256").update(stableStringify(v)).digest("hex");

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

export interface IdempotencyStore {
  /**
   * Run `fn` at most once per (scope, key). A repeat with the same fingerprint
   * returns the stored result (`replayed: true`); a repeat with a different
   * fingerprint is refused. A failed `fn` is NOT stored, so the caller may retry.
   */
  execute<T>(scopeKey: string, key: string, fp: string, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }>;
}

interface Entry {
  fp: string;
  expires: number;
  promise: Promise<unknown>;
}

/** In-memory store. Per-process: use a shared store for multi-replica deployments. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly ttlMs = 24 * 3600_000,
    private readonly now: () => number = Date.now,
  ) {}

  async execute<T>(scopeKey: string, key: string, fp: string, fn: () => Promise<T>) {
    const id = `${scopeKey}\u0000${key}`;
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expires <= t) this.entries.delete(k);

    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fp !== fp) {
        throw new DrivoMcpError(
          "idempotency_conflict",
          "This idempotency_key was already used with different parameters.",
          409,
        );
      }
      return { result: (await existing.promise) as T, replayed: true };
    }
    const promise = fn();
    this.entries.set(id, { fp, expires: t + this.ttlMs, promise });
    try {
      return { result: await promise, replayed: false };
    } catch (e) {
      this.entries.delete(id); // failures are retryable
      throw e;
    }
  }
}
