import { RateLimiter } from './limiter.ts';
import { extractStatus, withRetry } from './retry.ts';
import { RateLimitedError, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingResult, type UsageRecorder } from './types.ts';

export type GeminiConfig = {
  apiKey: string;
  model: string;
  dimensions: number;
  requestsPerMinute: number;
  requestsPerDay: number;
  batchSize: number;
  batchDelayMs: number;
  quotaShare?: number;
  recordUsage?: UsageRecorder;
  timeoutMs?: number;
  baseUrl?: string;
};

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Scales a vector to unit length.
 *
 * Gemini does NOT normalize MRL-truncated output. Measured: a 768-dimension
 * embedding came back with an L2 norm of 0.581 (D-017). Only the native
 * 3072-dimension output is normalized.
 *
 * This matters because `material_chunks.embedding` is indexed with
 * `vector_cosine_ops`. Ranking survives unnormalized input, but the distance
 * VALUES become incomparable between chunks — and the evidence-sufficiency gate
 * for unsupported-question handling (task 11) thresholds on an absolute
 * distance. Without this, that threshold means something different for every
 * chunk, which would quietly break the PRD's core "do not fabricate"
 * requirement.
 */
export function normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  // A zero vector cannot be normalized; return it unchanged rather than
  // producing NaNs that would poison every distance computation downstream.
  if (norm === 0 || !Number.isFinite(norm)) return vector;
  return vector.map((v) => v / norm);
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;

  constructor(private readonly config: GeminiConfig) {
    this.dimensions = config.dimensions;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    const share = config.quotaShare ?? 1;
    this.limiter = new RateLimiter({
      name: 'gemini:embedding',
      requestsPerMinute: Math.max(1, Math.floor(config.requestsPerMinute * share)),
      // Embeddings are billed per request on the free tier, not per token, so
      // the token dimension is effectively unbounded here.
      tokensPerMinute: Number.MAX_SAFE_INTEGER,
      requestsPerDay: Math.max(1, Math.floor(config.requestsPerDay * share)),
    });
  }

  snapshot() {
    return this.limiter.snapshot();
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
    if (req.texts.length === 0) {
      return { vectors: [], model: this.config.model, latencyMs: 0, calls: 0 };
    }

    const startedAt = Date.now();
    const batches = chunk(req.texts, this.config.batchSize);
    const vectors: number[][] = [];
    let calls = 0;

    for (const [index, batch] of batches.entries()) {
      // Pace between batches. Indexing one large PDF can be hundreds of chunks,
      // and firing them as fast as the event loop allows would burst straight
      // through the 100 RPM ceiling even though the daily budget is fine.
      if (index > 0 && this.config.batchDelayMs > 0) {
        await sleep(this.config.batchDelayMs);
      }

      const reservation = await this.limiter.reserve(1);
      try {
        const batchVectors = await withRetry(
          async (attempt) => {
            calls = Math.max(calls, index + 1);
            void attempt;
            return await this.embedBatch(batch, req.taskType);
          },
          { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 30_000 },
        );
        vectors.push(...batchVectors);
      } catch (error) {
        reservation.settle(1);
        const latencyMs = Date.now() - startedAt;
        void this.record(req, 'error', latencyMs, calls, {
          code: String(extractStatus(error) ?? 'unknown'),
          message: (error as Error)?.message ?? 'unknown',
        });
        throw error;
      }
      reservation.settle(1);
    }

    const latencyMs = Date.now() - startedAt;

    // A missing vector would silently shift every subsequent chunk's embedding
    // onto the wrong text, which is close to undetectable later.
    if (vectors.length !== req.texts.length) {
      throw new Error(
        `Gemini returned ${vectors.length} embeddings for ${req.texts.length} inputs.`,
      );
    }

    void this.record(req, 'success', latencyMs, calls);
    return { vectors, model: this.config.model, latencyMs, calls };
  }

  private async embedBatch(
    texts: string[],
    taskType: EmbeddingRequest['taskType'],
  ): Promise<number[][]> {
    const url = `${this.baseUrl}/models/${this.config.model}:batchEmbedContents`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.config.model}`,
            content: { parts: [{ text }] },
            outputDimensionality: this.config.dimensions,
            ...(taskType ? { taskType } : {}),
          })),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429 || /RESOURCE_EXHAUSTED/i.test(body)) {
          throw new RateLimitedError(`Gemini rate limited: ${body.slice(0, 200)}`);
        }
        const err = new Error(`Gemini embedding failed (${res.status}): ${body.slice(0, 300)}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }

      const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
      const embeddings = json.embeddings ?? [];

      return embeddings.map((e, i) => {
        const values = e.values;
        if (!Array.isArray(values) || values.length !== this.config.dimensions) {
          throw new Error(
            `Gemini returned ${values?.length ?? 0} dimensions for input ${i}, ` +
              `expected ${this.config.dimensions}. The column is vector(${this.config.dimensions}).`,
          );
        }
        // Always normalize — the caller must not be able to forget (D-017).
        return normalize(values);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(
    req: EmbeddingRequest,
    status: 'success' | 'error',
    latencyMs: number,
    calls: number,
    error?: { code: string; message: string },
  ): Promise<void> {
    if (!this.config.recordUsage) return;
    try {
      await this.config.recordUsage({
        userId: req.userId,
        projectId: req.projectId,
        feature: 'embedding',
        provider: 'gemini',
        model: this.config.model,
        usedFallback: false,
        status,
        latencyMs,
        attemptCount: Math.max(1, calls),
        errorCode: error?.code,
        errorMessage: error?.message?.slice(0, 500),
      });
    } catch {
      // Observability must never break the feature it observes.
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
