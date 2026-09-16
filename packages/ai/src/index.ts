/**
 * @asc/ai — the only place in the codebase that talks to an AI provider.
 *
 * Two roles, deliberately separate (CLAUDE.md):
 *   - Generation  → Groq, OpenAI-compatible endpoint via the `openai` SDK.
 *   - Embeddings  → Gemini, gemini-embedding-001.
 *
 * Both sit behind interfaces in types.ts so either can be swapped without
 * touching the rest of the app. Every call writes an `ai_requests` row through
 * the injected UsageRecorder — that is the AI observability story (PRD §14).
 *
 * Groq's TPM ceiling (8000) binds well before its RPM ceiling (30), and
 * reasoning tokens count against it (D-016). Callers must keep prompts compact;
 * this package enforces the budget but cannot invent headroom.
 */

export * from './types.ts';
export { RateLimiter, type LimiterConfig, type Reservation } from './limiter.ts';
export { withRetry, isRetryable, backoffDelay, retryAfterMs, extractStatus } from './retry.ts';
export { estimateTokens, estimateRequestTokens, estimateCostUsd, reasoningMultiplier } from './tokens.ts';
export { GroqProvider, type GroqConfig } from './groq.ts';
export { GeminiEmbeddingProvider, normalize, type GeminiConfig } from './gemini.ts';
export { generateJson, extractJson, type GenerateJsonOptions } from './json.ts';
