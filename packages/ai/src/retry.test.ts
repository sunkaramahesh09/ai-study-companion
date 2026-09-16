import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, isRetryable, retryAfterMs, withRetry } from './retry.ts';
import { RateLimitedError } from './types.ts';

const noSleep = async () => {};

describe('isRetryable', () => {
  it('retries 429 and 5xx', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('does not retry client errors', () => {
    // Retrying a 400 just burns quota against the same rejection.
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('retries transport failures that carry no status', () => {
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('retries our own RateLimitedError', () => {
    expect(isRetryable(new RateLimitedError('slow down'))).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('uses FULL jitter, not exponential plus a wobble', () => {
    // random()=0 must be able to produce 0 delay. Without full jitter, every
    // caller backs off on the same schedule and re-triggers the same 429
    // together — which is exactly the pile-up backoff is meant to break.
    expect(backoffDelay(1, 500, 20_000, () => 0)).toBe(0);
    expect(backoffDelay(3, 500, 20_000, () => 0)).toBe(0);
  });

  it('grows exponentially at the ceiling of the random range', () => {
    const max = () => 0.999999;
    const a1 = backoffDelay(1, 500, 20_000, max);
    const a2 = backoffDelay(2, 500, 20_000, max);
    const a3 = backoffDelay(3, 500, 20_000, max);
    expect(a1).toBeLessThan(a2);
    expect(a2).toBeLessThan(a3);
    expect(a1).toBeLessThanOrEqual(500);
    expect(a2).toBeLessThanOrEqual(1000);
  });

  it('never exceeds the cap', () => {
    expect(backoffDelay(20, 500, 20_000, () => 0.999999)).toBeLessThanOrEqual(20_000);
  });
});

describe('retryAfterMs', () => {
  it('reads a Retry-After header in seconds', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);
  });

  it('reads a Headers instance', () => {
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '2' }) })).toBe(2000);
  });

  it('returns undefined when absent', () => {
    expect(retryAfterMs({ headers: {} })).toBeUndefined();
    expect(retryAfterMs({})).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('recovered');
    const result = await withRetry(fn, { sleep: noSleep, random: () => 0.5 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429, message: 'rate limited' });
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toMatchObject({
      status: 429,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('prefers the server Retry-After over computed backoff', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '7' } })
      .mockResolvedValue('ok');
    await withRetry(fn, {
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });
    expect(delays).toEqual([7000]);
  });
});
