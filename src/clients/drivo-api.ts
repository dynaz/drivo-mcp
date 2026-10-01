import { DrivoMcpError } from "../errors/mcp-error.js";
import type { Logger } from "../audit/logger.js";

export interface ApiCallContext {
  token: string;
  requestId: string;
}

export interface ApiResult<T = unknown> {
  data: T;
  count?: number;
}

export interface DrivoApiOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  logger?: Logger;
  /** GET-only retries on network error / 502 / 503 / 504. */
  getRetries?: number;
}

/**
 * The ONLY door to Drivo. It speaks the existing carbox_api REST layer
 * (`/api/v1/*`, bearer auth, RBAC + company scoping enforced server-side) and
 * never talks to PostgreSQL or raw Odoo RPC.
 */
export class DrivoApiClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: DrivoApiOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async get<T = unknown>(path: string, query: Record<string, string | number | boolean | undefined>, ctx: ApiCallContext): Promise<ApiResult<T>> {
    const url = new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const attempts = 1 + (this.opts.getRetries ?? 1);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.send(url, { method: "GET" }, ctx);
        if ([502, 503, 504].includes(res.status) && i < attempts - 1) {
          await sleep(150 * (i + 1));
          continue;
        }
        return await this.parse<T>(res);
      } catch (e) {
        last = e;
        const retryable = e instanceof DrivoMcpError && (e.code === "upstream_unavailable" || e.code === "upstream_timeout");
        if (!retryable || i === attempts - 1) throw e;
        await sleep(150 * (i + 1));
      }
    }
    throw last;
  }

  /** Drivo's POST routes are Odoo `type='json'`: JSON-RPC envelope in, `result` out. Never retried. */
  async post<T = unknown>(path: string, params: Record<string, unknown>, ctx: ApiCallContext): Promise<ApiResult<T>> {
    const url = new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
    const res = await this.send(
      url,
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }), headers: { "Content-Type": "application/json" } },
      ctx,
    );
    return this.parse<T>(res);
  }

  private async send(url: URL, init: RequestInit, ctx: ApiCallContext): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: ac.signal,
        headers: {
          Accept: "application/json",
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${ctx.token}`,
          "X-Request-Id": ctx.requestId,
        },
      });
    } catch (e) {
      if (ac.signal.aborted) throw new DrivoMcpError("upstream_timeout", "The Drivo API did not respond in time.", 504, e);
      throw new DrivoMcpError("upstream_unavailable", "The Drivo API is unreachable.", 502, e);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response): Promise<ApiResult<T>> {
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new DrivoMcpError("upstream_error", "The Drivo API returned an unreadable response.", 502);
    }
    // Odoo type='json' wraps the payload in {result} / {error}.
    if (body && typeof body === "object" && !("status" in body) && ("jsonrpc" in body || "result" in body || "error" in body)) {
      if (body.error) throw new DrivoMcpError("upstream_error", "The Drivo API rejected the request.", 502, body.error);
      body = body.result;
    }
    if (res.status === 401) throw new DrivoMcpError("upstream_error", "Drivo rejected the server's upstream credentials.", 502);
    if (res.status === 403) throw new DrivoMcpError("forbidden", "Drivo denied access to this resource.", 403);
    if (res.status === 404) throw new DrivoMcpError("not_found", "Record not found.", 404);
    if (res.status >= 500) throw new DrivoMcpError("upstream_error", "The Drivo API failed to process the request.", 502, body);
    if (!res.ok || !body || body.status === "error") {
      throw businessError(typeof body?.message === "string" ? body.message : undefined, res.status);
    }
    return { data: body.data as T, count: typeof body.count === "number" ? body.count : undefined };
  }
}

const LEAKY = /traceback|psycopg|File "|odoo\.|sql|\n/i;

/** Drivo's 4xx / status:error messages are written for dealer staff; pass them on only if they look like prose. */
function businessError(message: string | undefined, status: number): DrivoMcpError {
  const m = message?.trim();
  if (m && m.length <= 200 && !LEAKY.test(m)) {
    const lower = m.toLowerCase();
    if (lower.includes("not found")) return new DrivoMcpError("not_found", "Record not found.", 404);
    if (lower === "forbidden") return new DrivoMcpError("forbidden", "Drivo denied access to this resource.", 403);
    return new DrivoMcpError("invalid_input", m, status >= 400 && status < 500 ? status : 422);
  }
  return new DrivoMcpError("upstream_error", "The Drivo API rejected the request.", 502);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
