/**
 * The contract every AI provider implements. Two roles, deliberately separate
 * (CLAUDE.md): generation (Groq) and embeddings (Gemini). Callers depend on
 * these types, never on a vendor SDK, so either provider can be replaced
 * without touching the rest of the application.
 */

/** Which product surface spent the tokens. Mirrors `ai_requests.feature`. */
export type AiFeature =
  | 'tutor_answer'
  | 'concept_extraction'
  | 'question_generation'
  | 'open_answer_grading'
  | 'recommendation'
  | 'embedding'
  | 'evaluation'
  | 'flashcard_generation';

export type AiStatus = 'success' | 'error' | 'rate_limited' | 'invalid_output' | 'timeout';

/**
 * Model tier. `primary` is the higher-quality model for grounded Tutor answers;
 * `fallback` is for short, high-volume work (single-answer grading, single
 * question generation) and draws from a separate quota pool.
 */
export type ModelTier = 'primary' | 'fallback';

/**
 * Reasoning budget. gpt-oss models spend completion tokens on internal
 * reasoning before producing content, and those tokens are billed against the
 * 8000 TPM ceiling — measured at 73% of completion tokens for a one-word answer
 * at default effort. So this is a cost decision, not only a quality one (D-016).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type GenerationRequest = {
  feature: AiFeature;
  /** Instructions. Never contains user or document content — see the prompt boundary in task 12. */
  system: string;
  messages: ChatMessage[];
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** JSON mode. The schema still has to be validated afterwards — Groq does not guarantee it. */
  json?: boolean;
  /** Ownership context, recorded on the ai_requests row. */
  userId?: string;
  projectId?: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Subset of completionTokens spent on internal reasoning (D-016). */
  reasoningTokens: number;
  totalTokens: number;
};

export type GenerationResult = {
  text: string;
  model: string;
  /** True when the primary model rate-limited and we failed over. */
  usedFallback: boolean;
  usage: TokenUsage;
  latencyMs: number;
  attempts: number;
};

export interface GenerationProvider {
  generate(req: GenerationRequest): Promise<GenerationResult>;
}

export type EmbeddingRequest = {
  texts: string[];
  /**
   * RETRIEVAL_DOCUMENT when indexing, RETRIEVAL_QUERY when searching. Gemini
   * embeds the same text differently depending on which side it is on, and
   * mismatching them measurably degrades retrieval.
   */
  taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  userId?: string;
  projectId?: string;
};

export type EmbeddingResult = {
  /** Unit-normalized vectors, one per input, in input order (D-017). */
  vectors: number[][];
  model: string;
  latencyMs: number;
  /** Number of upstream API calls made — inputs are batched. */
  calls: number;
};

export interface EmbeddingProvider {
  embed(req: EmbeddingRequest): Promise<EmbeddingResult>;
  readonly dimensions: number;
}

/**
 * One row per provider call — the whole AI observability story (PRD §14).
 * Implemented by the application (which owns the database connection) and
 * injected, so this package stays free of app dependencies and is testable
 * without a database.
 */
export type AiRequestRecord = {
  userId?: string | undefined;
  projectId?: string | undefined;
  feature: AiFeature;
  provider: 'groq' | 'gemini';
  model: string;
  usedFallback: boolean;
  status: AiStatus;
  latencyMs: number;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  estimatedCostUsd?: number | undefined;
  attemptCount: number;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
};

export type UsageRecorder = (record: AiRequestRecord) => void | Promise<void>;

/** Raised when a provider returns something we refuse to use. */
export class InvalidOutputError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}
