import { LogAuditSink, Logger, type AuditSink } from "./audit/logger.js";
import { PrincipalRegistry } from "./auth/api-key.js";
import { DrivoApiClient } from "./clients/drivo-api.js";
import type { Config } from "./config.js";
import { Confirmations } from "./runtime/confirmation.js";
import { ToolRuntime } from "./runtime/executor.js";
import { InMemoryIdempotencyStore } from "./runtime/idempotency.js";
import { InMemoryRateLimiter } from "./runtime/rate-limit.js";

export function buildApp(cfg: Config, overrides: { audit?: AuditSink; logger?: Logger } = {}) {
  const logger = overrides.logger ?? new Logger(cfg.LOG_LEVEL);
  const registry = PrincipalRegistry.fromFile(cfg.DRIVO_MCP_PRINCIPALS_FILE);
  const api = new DrivoApiClient({ baseUrl: cfg.DRIVO_API_BASE_URL, timeoutMs: cfg.DRIVO_API_TIMEOUT_MS, logger });
  const runtime = new ToolRuntime({
    api,
    logger,
    audit: overrides.audit ?? new LogAuditSink(logger),
    rateLimiter: new InMemoryRateLimiter(),
    idempotency: new InMemoryIdempotencyStore(),
    confirmations: new Confirmations(cfg.DRIVO_MCP_CONFIRM_SECRET),
    readLimitPerMinute: cfg.DRIVO_MCP_RATE_LIMIT_PER_MINUTE,
    writeLimitPerMinute: cfg.DRIVO_MCP_WRITE_RATE_LIMIT_PER_MINUTE,
  });
  return { logger, registry, api, runtime };
}
