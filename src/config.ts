import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  // Postgres connection string. Unset => embedded PGlite (local dev / tests only).
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),

  // Required in production; guards /admin/*.
  ADMIN_TOKEN: z.string().min(24, "ADMIN_TOKEN must be at least 24 chars"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta/openai"),
  GEMINI_CAPABLE_MODEL: z.string().default("gemini-3.8-flash"),
  // Same tier and price as the primary; tried before degrading to the cheap model. "" disables.
  GEMINI_CAPABLE_FALLBACK_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_CHEAP_MODEL: z.string().default("gemini-3.5-flash-lite"),
  // Gemini 3 can't disable thinking, and thinking tokens are billed output that also
  // count against max_tokens; "low" keeps both small unless the caller asks for more.
  DEFAULT_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  OLLAMA_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().default("qwen2.5:1.5b"),
  OLLAMA_NUM_CTX_MAX: z.coerce.number().int().default(8192),

  ENABLE_MOCK_PROVIDER: bool.optional(),

  // Two attempts must fit inside REQUEST_DEADLINE_MS.
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().default(12_000),
  // Below Render's 30s shutdown grace period, so a redeploy never kills a request mid-settle.
  REQUEST_DEADLINE_MS: z.coerce.number().int().default(28_000),
  DEFAULT_MAX_TOKENS: z.coerce.number().int().default(1024),
  MAX_TOKENS_CAP: z.coerce.number().int().default(4096),

  USD_TO_INR: z.coerce.number().positive().default(88),
  RESERVATION_TTL_MS: z.coerce.number().int().default(5 * 60_000),
});

export type Config = z.infer<typeof schema> & { enableMock: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production" && !c.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  // Mock answers must never reach real callers unless explicitly opted in.
  const enableMock = c.ENABLE_MOCK_PROVIDER ?? c.NODE_ENV !== "production";
  return { ...c, enableMock };
}
