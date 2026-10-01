import { z } from "zod";

const Env = z.object({
  DRIVO_API_BASE_URL: z.string().url(),
  DRIVO_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  MCP_TRANSPORT: z.enum(["http", "stdio"]).default("http"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  MCP_ALLOWED_HOSTS: z.string().default(""),
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  DRIVO_MCP_PRINCIPALS_FILE: z.string().min(1),
  DRIVO_MCP_API_KEY: z.string().optional(), // stdio mode only
  DRIVO_MCP_CONFIRM_SECRET: z.string().min(16),
  DRIVO_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  DRIVO_MCP_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  if (e.MCP_TRANSPORT === "stdio" && !e.DRIVO_MCP_API_KEY) {
    throw new Error("DRIVO_MCP_API_KEY is required for stdio transport");
  }
  return { ...e, allowedHosts: list(e.MCP_ALLOWED_HOSTS), allowedOrigins: list(e.MCP_ALLOWED_ORIGINS) };
}
