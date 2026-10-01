import { createHmac, timingSafeEqual } from "node:crypto";
import { DrivoMcpError } from "../errors/mcp-error.js";
import { fingerprint } from "./idempotency.js";

/**
 * Two-step confirmation for high-risk writes. Step 1 (no token) returns a
 * preview plus a signed, short-lived token bound to {principal, tool, exact
 * arguments}. Step 2 must replay the same arguments with that token. Changing
 * any argument, principal or tool invalidates it, so a model cannot "confirm"
 * something the human was never shown.
 */
export class Confirmations {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 16) throw new Error("DRIVO_MCP_CONFIRM_SECRET must be at least 16 chars");
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  issue(principalId: string, tool: string, args: unknown): { token: string; expiresAt: string } {
    const exp = this.now() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({ p: principalId, t: tool, h: fingerprint(args), e: exp })).toString("base64url");
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: new Date(exp).toISOString() };
  }

  verify(token: string, principalId: string, tool: string, args: unknown): void {
    const bad = () => new DrivoMcpError("confirmation_invalid", "Confirmation token is invalid or expired. Request a new preview.", 400);
    const [payload, sig] = token.split(".");
    if (!payload || !sig) throw bad();
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
    let c: { p: string; t: string; h: string; e: number };
    try {
      c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw bad();
    }
    if (c.p !== principalId || c.t !== tool || c.h !== fingerprint(args) || c.e < this.now()) throw bad();
  }
}
