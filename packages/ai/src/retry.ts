import { RateLimitedError } from './types.ts';

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; defaults to real time. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 429, 408, 5xx and transport errors are worth retrying. A 400 never is. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitedError) return true;
  const status = extractStatus(error);
  if (status === 429 || status === 408) return true;
  if (status !== undefined && status >= 500) return true;
  if (status !== undefined) return false;
  // No status at all: a socket hang-up or DNS blip, which is worth one more go.
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

export function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/**
 * Honour the server's own backoff hint when it gives one. Groq sends
 * `retry-after` in seconds; Gemini's RESOURCE_EXHAUSTED carries a RetryInfo
 * duration. Obeying it beats guessing, and prevents a retry storm from every
 * process backing off on the same schedule.
 */
export function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof RateLimitedError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return undefined;

  const read = (key: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(key) ?? undefined;
    const value = (headers as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  };

  const raw = read('retry-after') ?? read('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

/**
 * Exponential backoff with FULL jitter: the delay is a uniform random value in
 * [0, exponential], not exponential ± a wobble.
 *
 * This matters more than it looks. With several workers hitting an 8000 TPM
 * ceiling, a deterministic backoff makes every caller retry at the same instant
 * and re-trigger the same 429 together. Full jitter spreads them out and is
 * what actually clears a rate-limit pile-up.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * exponential);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;

      // A server-supplied delay wins over our guess.
      const hinted = retryAfterMs(error);
      const delayMs = hinted ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
