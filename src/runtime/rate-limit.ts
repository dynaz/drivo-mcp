export interface RateLimiter {
  /** Returns whether the call may proceed. `bucket` separates read and write budgets. */
  check(key: string, bucket: "read" | "write", limitPerMinute: number): { allowed: boolean; retryAfterMs: number };
}

/** Fixed-window in-memory limiter. Swap for a shared (Redis) implementation when running >1 replica. */
export class InMemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  check(key: string, bucket: "read" | "write", limitPerMinute: number) {
    const k = `${key}:${bucket}`;
    const t = this.now();
    let w = this.windows.get(k);
    if (!w || t - w.start >= 60_000) {
      w = { start: t, count: 0 };
      this.windows.set(k, w);
    }
    if (w.count >= limitPerMinute) return { allowed: false, retryAfterMs: 60_000 - (t - w.start) };
    w.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}
