import { z } from 'zod';

/**
 * Fail fast on misconfiguration. A prototype that boots with a missing key and
 * dies later inside a background job is much harder to debug than one that
 * refuses to start — and secrets living only in the environment is a PRD
 * requirement (§18), so this is also the one place that reads them.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  // Server/worker only. Bypasses RLS — must never reach the browser bundle.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  GROQ_API_KEY: z.string().min(1),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_PRIMARY_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_FALLBACK_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_RPM: z.coerce.number().int().positive().default(30),
  GROQ_RPD: z.coerce.number().int().positive().default(1000),
  GROQ_TPM: z.coerce.number().int().positive().default(8000),
  GROQ_TPD: z.coerce.number().int().positive().default(200_000),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  GEMINI_RPM: z.coerce.number().int().positive().default(100),
  GEMINI_RPD: z.coerce.number().int().positive().default(1000),
  // 768 keeps vectors inside pgvector's 2000-dim index ceiling — see D-004.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  EMBEDDING_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(700),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Pure parse. Always re-reads the source it is handed — no memoization, so it
 * stays testable and so passing an explicit `source` actually means something.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/**
 * Process-wide environment, parsed once. This is the memoized accessor the
 * server and worker use; tests should call `parseEnv` directly.
 */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
