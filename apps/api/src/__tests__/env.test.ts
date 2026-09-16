import { describe, expect, it } from 'vitest';
import { corsOrigins, parseEnv } from '../env.ts';

const valid = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_URL: 'postgresql://postgres:x@localhost:5432/postgres',
  GROQ_API_KEY: 'groq',
  GEMINI_API_KEY: 'gemini',
} satisfies NodeJS.ProcessEnv;

describe('env validation', () => {
  it('applies the documented provider defaults', () => {
    const env = parseEnv({ ...valid });
    expect(env.GROQ_PRIMARY_MODEL).toBe('openai/gpt-oss-120b');
    expect(env.GROQ_FALLBACK_MODEL).toBe('openai/gpt-oss-20b');
    expect(env.GROQ_BASE_URL).toBe('https://api.groq.com/openai/v1');
    expect(env.GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
  });

  it('defaults TPM to the binding Groq constraint', () => {
    // TPM (8000), not RPM (30), is what limits us in practice — if this default
    // ever drifts, the rate limiter silently over-spends the quota.
    const env = parseEnv({ ...valid });
    expect(env.GROQ_TPM).toBe(8000);
    expect(env.GROQ_RPM).toBe(30);
  });

  it('defaults embeddings to 768 dims to stay inside pgvector index limits', () => {
    // See D-004. Above 2000 dims pgvector cannot index, and every retrieval
    // degrades to a sequential scan.
    const env = parseEnv({ ...valid });
    expect(env.EMBEDDING_DIMENSIONS).toBe(768);
    expect(env.EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(2000);
  });

  it('refuses to boot when a required secret is missing', () => {
    const { GROQ_API_KEY: _omitted, ...incomplete } = valid;
    expect(() => parseEnv(incomplete)).toThrow(/GROQ_API_KEY/);
  });

  it('refuses a malformed Supabase URL rather than failing later at call time', () => {
    expect(() => parseEnv({ ...valid, SUPABASE_URL: 'not-a-url' })).toThrow(/SUPABASE_URL/);
  });

  it('parses a comma-separated CORS allowlist', () => {
    const env = parseEnv({ ...valid, CORS_ORIGINS: 'http://a.com, http://b.com ,' });
    expect(corsOrigins(env)).toEqual(['http://a.com', 'http://b.com']);
  });
});
