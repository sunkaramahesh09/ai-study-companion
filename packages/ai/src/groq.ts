import OpenAI from 'openai';
import { RateLimiter } from './limiter.ts';
import { extractStatus, withRetry } from './retry.ts';
import { estimateCostUsd, estimateRequestTokens } from './tokens.ts';
import {
  InvalidOutputError,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ModelTier,
  type TokenUsage,
  type UsageRecorder,
} from './types.ts';

export type GroqConfig = {
  apiKey: string;
  baseUrl: string;
  primaryModel: string;
  fallbackModel: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  /**
   * Fraction of the documented quota this process may use, PER TIER.
   *
   * Per tier, not one number, because the two tiers are separate quota pools
   * upstream and the two services use them very differently: the API serves
   * interactive Tutor answers on `primary`, while the worker's generation load
   * (grading, question wording) sits on `fallback`. A single split starves
   * whichever process actually needs the tier. See D-022.
   */
  quotaShare?: number | { primary: number; fallback: number };
  recordUsage?: UsageRecorder;
  timeoutMs?: number;
};

/**
 * Floor on max_tokens.
 *
 * gpt-oss burns completion tokens on reasoning before emitting any content, so
 * a small max_tokens truncates the response to an EMPTY STRING with no error
 * (measured: max_tokens=10 produced 8 reasoning tokens and `""`). Anything
 * below this reliably returns nothing (D-016).
 */
const MIN_MAX_TOKENS = 256;

export class GroqProvider implements GenerationProvider {
  private readonly client: OpenAI;
  /** One limiter per model: the two tiers draw on separate quota pools. */
  private readonly limiters: Record<ModelTier, RateLimiter>;

  constructor(private readonly config: GroqConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // Retries are ours: the SDK's own would bypass the rate limiter and the
      // ai_requests accounting.
      maxRetries: 0,
      timeout: config.timeoutMs ?? 60_000,
    });

    const raw = config.quotaShare ?? 1;
    const shares =
      typeof raw === 'number' ? { primary: raw, fallback: raw } : raw;

    const mk = (tier: ModelTier) => {
      const share = shares[tier];
      return new RateLimiter({
        name: `groq:${tier}`,
        requestsPerMinute: Math.max(1, Math.floor(config.requestsPerMinute * share)),
        tokensPerMinute: Math.max(1, Math.floor(config.tokensPerMinute * share)),
        requestsPerDay: Math.max(1, Math.floor(config.requestsPerDay * share)),
        tokensPerDay: Math.max(1, Math.floor(config.tokensPerDay * share)),
      });
    };

    this.limiters = { primary: mk('primary'), fallback: mk('fallback') };
  }

  modelFor(tier: ModelTier): string {
    return tier === 'primary' ? this.config.primaryModel : this.config.fallbackModel;
  }

  /**
   * This process's per-minute token ceiling on a tier, after the quota share.
   *
   * Exposed because a caller that BUILDS a prompt needs to size it against the
   * ceiling it will be admitted through. Hard-coding a budget against a share
   * is how concept extraction silently died when the shares were rebalanced:
   * the limiter rejected every request outright, permanently, and the only
   * symptom was a project stuck at zero concepts (D-088).
   */
  tokensPerMinuteFor(tier: ModelTier): number {
    return this.limiters[tier].tokensPerMinuteCeiling();
  }

  snapshot() {
    return {
      primary: this.limiters.primary.snapshot(),
      fallback: this.limiters.fallback.snapshot(),
    };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const requestedTier: ModelTier = req.tier ?? 'primary';

    try {
      return await this.callTier(req, requestedTier, false);
    } catch (error) {
      const isRateLimit = extractStatus(error) === 429 || /quota exhausted/i.test(String(error));

      // Automatic failover: only for a 429 the retries could not clear, and
      // only from primary. Failing over on a 400 would repeat the same bad
      // request against a second model and waste a second quota pool.
      if (isRateLimit && requestedTier === 'primary') {
        return await this.callTier(req, 'fallback', true);
      }
      throw error;
    }
  }

  private async callTier(
    req: GenerationRequest,
    tier: ModelTier,
    usedFallback: boolean,
  ): Promise<GenerationResult> {
    const model = this.modelFor(tier);
    const limiter = this.limiters[tier];

    // Below the floor the model returns "" with no error (D-016).
    const maxTokens = Math.max(MIN_MAX_TOKENS, req.maxTokens ?? 1024);
    const estimate = estimateRequestTokens({
      system: req.system,
      messages: req.messages,
      maxTokens,
      reasoningEffort: req.reasoningEffort,
    });

    const startedAt = Date.now();
    let attempts = 0;
    const reservation = await limiter.reserve(estimate);

    try {
      const completion = await withRetry(
        async (attempt) => {
          attempts = attempt;
          return await this.client.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: req.system },
              ...req.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
            max_completion_tokens: maxTokens,
            temperature: req.temperature ?? 0.2,
            ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
            // Not in the SDK's typed params for every model, but Groq accepts
            // it for gpt-oss and it is our main lever on reasoning cost.
            ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          } as Parameters<OpenAI['chat']['completions']['create']>[0]);
        },
        { maxAttempts: 4, baseDelayMs: 600, maxDelayMs: 20_000 },
      );

      const choice = 'choices' in completion ? completion.choices[0] : undefined;
      const text = choice?.message?.content ?? '';
      const raw = completion as unknown as {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };

      const usage: TokenUsage = {
        promptTokens: raw.usage?.prompt_tokens ?? 0,
        completionTokens: raw.usage?.completion_tokens ?? 0,
        reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: raw.usage?.total_tokens ?? 0,
      };

      reservation.settle(usage.totalTokens || estimate);
      const latencyMs = Date.now() - startedAt;

      // Empty content is a FAILURE, not an empty answer. It means the token
      // budget was consumed by reasoning before any content was produced
      // (D-016). Treating it as valid output would push "" downstream into a
      // JSON parse that throws far from the real cause.
      if (text.trim() === '') {
        void this.record(req, model, usedFallback, 'invalid_output', latencyMs, usage, attempts, {
          code: choice?.finish_reason ?? 'empty_content',
          message:
            `Model returned empty content after ${usage.completionTokens} completion tokens ` +
            `(${usage.reasoningTokens} reasoning). Raise max_tokens or lower reasoning_effort.`,
        });
        throw new InvalidOutputError(
          `${model} returned empty content (finish_reason=${choice?.finish_reason ?? 'unknown'}, ` +
            `${usage.reasoningTokens} reasoning tokens). The completion budget was spent on ` +
            `reasoning before any content was produced.`,
        );
      }

      void this.record(req, model, usedFallback, 'success', latencyMs, usage, attempts);

      return { text, model, usedFallback, usage, latencyMs, attempts };
    } catch (error) {
      reservation.settle(estimate);
      if (error instanceof InvalidOutputError) throw error;

      const status = extractStatus(error);
      const latencyMs = Date.now() - startedAt;
      void this.record(
        req,
        model,
        usedFallback,
        status === 429 ? 'rate_limited' : status === 408 ? 'timeout' : 'error',
        latencyMs,
        undefined,
        attempts,
        { code: status ? String(status) : 'unknown', message: (error as Error)?.message ?? 'unknown' },
      );
      throw error;
    }
  }

  private async record(
    req: GenerationRequest,
    model: string,
    usedFallback: boolean,
    status: 'success' | 'error' | 'rate_limited' | 'invalid_output' | 'timeout',
    latencyMs: number,
    usage: TokenUsage | undefined,
    attemptCount: number,
    error?: { code: string; message: string },
  ): Promise<void> {
    if (!this.config.recordUsage) return;
    try {
      await this.config.recordUsage({
        userId: req.userId,
        projectId: req.projectId,
        feature: req.feature,
        provider: 'groq',
        model,
        usedFallback,
        status,
        latencyMs,
        promptTokens: usage?.promptTokens,
        // Includes reasoning tokens, because that is what the API bills (D-016).
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
        estimatedCostUsd: usage
          ? estimateCostUsd(model, usage.promptTokens, usage.completionTokens)
          : undefined,
        attemptCount: Math.max(1, attemptCount),
        errorCode: error?.code,
        errorMessage: error?.message?.slice(0, 500),
      });
    } catch {
      // Observability must never break the feature it observes.
    }
  }
}
