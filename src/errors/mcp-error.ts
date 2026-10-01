/**
 * Every failure that reaches an MCP client goes through DrivoMcpError.
 * `publicMessage` is the ONLY text a client ever sees; `cause` is for logs.
 * Upstream error bodies, stack traces and tokens must never end up in it.
 */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "company_forbidden"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "confirmation_required"
  | "confirmation_invalid"
  | "idempotency_conflict"
  | "upstream_error"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "internal_error";

export class DrivoMcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly publicMessage: string,
    public readonly httpStatus = 500,
    public readonly cause?: unknown,
    public readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = "DrivoMcpError";
  }
}

/** Map any thrown value to a safe, client-visible error. */
export function toSafeError(err: unknown): DrivoMcpError {
  if (err instanceof DrivoMcpError) return err;
  return new DrivoMcpError("internal_error", "Unexpected server error.", 500, err);
}
