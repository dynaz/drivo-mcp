/** Structured JSON logging + audit sink. Secrets are redacted by key and by value shape. */
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|private[-_]?key|bearer)/i;
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Sink = (line: string) => void;

export class Logger {
  constructor(
    private readonly level: Level = "info",
    // stderr: stdout is reserved for the MCP protocol in stdio mode.
    private readonly sink: Sink = (l) => process.stderr.write(l + "\n"),
  ) {}

  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    this.sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) }));
  }
  debug = (m: string, f?: Record<string, unknown>) => this.log("debug", m, f);
  info = (m: string, f?: Record<string, unknown>) => this.log("info", m, f);
  warn = (m: string, f?: Record<string, unknown>) => this.log("warn", m, f);
  error = (m: string, f?: Record<string, unknown>) => this.log("error", m, f);
}

export interface AuditEvent {
  requestId: string;
  tool: string;
  principalId: string;
  userId: number;
  companyId: number;
  write: boolean;
  outcome: "ok" | "denied" | "invalid" | "error" | "rate_limited" | "confirmation_required" | "replayed";
  errorCode?: string;
  durationMs: number;
  idempotencyKey?: string;
  /** Redacted copy of the input. Never raw secrets; PII-bearing free text is length-capped. */
  input: unknown;
}

export interface AuditSink {
  record(e: AuditEvent): void;
}

export class LogAuditSink implements AuditSink {
  constructor(private readonly logger: Logger) {}
  record(e: AuditEvent): void {
    this.logger.info("audit", { audit: true, ...e, input: capStrings(e.input) });
  }
}

function capStrings(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => capStrings(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  }
  return v;
}
