import { GeminiEmbeddingProvider, GroqProvider, type AiRequestRecord } from '@asc/ai';
import { loadEnv } from '../env.ts';
import { serviceClient } from './supabase.ts';

/**
 * Wires @asc/ai to this application: real config, and a usage recorder backed
 * by the `ai_requests` table.
 *
 * The recorder uses the service role deliberately. ai_requests has a SELECT
 * policy for owners and admins and no INSERT policy for `authenticated`, so
 * clients can read their own AI usage but cannot forge rows — writes only
 * happen here, from the server.
 */
async function recordUsage(record: AiRequestRecord): Promise<void> {
  const { error } = await serviceClient().from('ai_requests').insert({
    user_id: record.userId ?? null,
    project_id: record.projectId ?? null,
    feature: record.feature,
    provider: record.provider,
    model: record.model,
    used_fallback: record.usedFallback,
    status: record.status,
    latency_ms: record.latencyMs,
    prompt_tokens: record.promptTokens ?? null,
    completion_tokens: record.completionTokens ?? null,
    total_tokens: record.totalTokens ?? null,
    estimated_cost_usd: record.estimatedCostUsd ?? null,
    attempt_count: record.attemptCount,
    error_code: record.errorCode ?? null,
    error_message: record.errorMessage ?? null,
  });
  if (error) {
    // Logged, never thrown: observability must not break the feature it
    // observes. The provider layer also swallows this, so this is belt and
    // braces.
    console.error('[ai] failed to record usage', error.message);
  }
}

/**
 * Quota share for this process.
 *
 * The API and the worker are separate Railway services with separate memories,
 * so their in-process limiters cannot see each other. Splitting the documented
 * quota between them keeps the SUM under the real ceiling (D-022).
 *
 * Split PER TIER, because the tiers are separate quota pools upstream and the
 * two services use them asymmetrically:
 *
 *   primary  — the Tutor's grounded answers, served by the API. A single
 *              grounded request costs ~3700 tokens once retrieved evidence and
 *              the reasoning allowance are counted, so the API needs most of
 *              this pool or interactive answers fail outright.
 *   fallback — grading and question wording, run by the worker in background
 *              workflows. High volume, small prompts, latency-tolerant.
 *
 * Gemini is embeddings only, which is almost entirely the worker's indexing
 * job; the API needs a sliver for query-side embedding during retrieval.
 */
function quotaShare(): { groq: { primary: number; fallback: number }; gemini: number } {
  const isWorker = process.env.ASC_ROLE === 'worker';

  // The share splits a quota between the two PROCESSES that compete for it.
  // It must not also split between the two model tiers: Groq meters 8000 TPM
  // per model, so gpt-oss-120b and gpt-oss-20b have independent pools and a
  // token spent on one costs nothing on the other.
  //
  // The earlier values gave the API fallback: 0.25, capping question
  // generation at 2000 TPM against a model that actually allows 8000. At
  // ~1,150 estimated tokens per question that is under two questions a minute,
  // so the second question in any minute waited for the window to roll.
  // Measured in production: p50 1,017ms, p95 57,224ms, max 59,702ms, with
  // attempt_count 1 throughout — the wait was ours, not the provider's and not
  // a retry. See D-062.
  return isWorker
    ? { groq: { primary: 0.25, fallback: 0.25 }, gemini: 0.85 }
    : { groq: { primary: 0.75, fallback: 0.75 }, gemini: 0.15 };
}

let groq: GroqProvider | undefined;
let gemini: GeminiEmbeddingProvider | undefined;

export function generationProvider(): GroqProvider {
  const env = loadEnv();
  if (!env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set. AI generation is unavailable. See .env.example.');
  }
  groq ??= new GroqProvider({
    apiKey: env.GROQ_API_KEY,
    baseUrl: env.GROQ_BASE_URL,
    primaryModel: env.GROQ_PRIMARY_MODEL,
    fallbackModel: env.GROQ_FALLBACK_MODEL,
    requestsPerMinute: env.GROQ_RPM,
    tokensPerMinute: env.GROQ_TPM,
    requestsPerDay: env.GROQ_RPD,
    tokensPerDay: env.GROQ_TPD,
    quotaShare: quotaShare().groq,
    recordUsage,
  });
  return groq;
}

export function embeddingProvider(): GeminiEmbeddingProvider {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Indexing and retrieval are unavailable.');
  }
  gemini ??= new GeminiEmbeddingProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    requestsPerMinute: env.GEMINI_RPM,
    requestsPerDay: env.GEMINI_RPD,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    batchDelayMs: env.EMBEDDING_BATCH_DELAY_MS,
    quotaShare: quotaShare().gemini,
    recordUsage,
  });
  return gemini;
}
