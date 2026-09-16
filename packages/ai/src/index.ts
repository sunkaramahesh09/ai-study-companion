/**
 * @asc/ai — the only place in the codebase that talks to an AI provider.
 *
 * Two roles, deliberately separate (CLAUDE.md "AI providers"):
 *   - Generation  → Groq, OpenAI-compatible endpoint via the `openai` SDK.
 *   - Embeddings  → Gemini, gemini-embedding-001.
 *
 * Both sit behind interfaces so either can be swapped without touching the
 * rest of the app. Every call through this package writes an `ai_requests`
 * row (model, feature, latency, tokens, estimated cost, success/failure) —
 * that is the AI observability story the PRD asks for in §14.
 *
 * Groq's TPM ceiling (8000) binds well before its RPM ceiling (30). Callers
 * must keep prompts compact; this package enforces the budget but cannot
 * invent headroom.
 */

export const PACKAGE_NAME = '@asc/ai' as const;
