import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limiter.ts';

/** Controllable clock so the tests assert behaviour, not wall-clock timing. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    // Sleeping advances the clock instead of waiting.
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('admits requests while both budgets have room', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ name: 'test', requestsPerMinute: 10, tokensPerMinute: 1000, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i++) await l.reserve(100);
    expect(l.snapshot()).toMatchObject({ requests: 5, tokens: 500 });
  });

  it('blocks on TOKENS before it blocks on requests', async () => {
    // The whole point: Groq allows 30 RPM but only 8000 TPM, so a few large
    // requests exhaust tokens while the request budget is barely touched.
    const c = fakeClock();
    const l = new RateLimiter({ name: 'groq', requestsPerMinute: 30, tokensPerMinute: 8000, now: c.now, sleep: c.sleep });

    for (let i = 0; i < 4; i++) await l.reserve(2000);
    const afterFour = l.snapshot();
    expect(afterFour.tokens).toBe(8000);
    expect(afterFour.requests).toBe(4); // nowhere near the 30 RPM ceiling

    const before = c.now();
    await l.reserve(2000); // must wait for the window to roll
    expect(c.now()).toBeGreaterThan(before);
  });

  it('frees capacity once the window rolls forward', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ name: 'test', requestsPerMinute: 2, tokensPerMinute: 1000, now: c.now, sleep: c.sleep });
    await l.reserve(100);
    await l.reserve(100);
    expect(l.snapshot().requests).toBe(2);

    c.advance(61_000);
    expect(l.snapshot().requests).toBe(0);
    await l.reserve(100);
    expect(l.snapshot().requests).toBe(1);
  });

  it('settle() replaces the estimate with real usage', async () => {
    // Reasoning tokens make completion size hard to predict (D-016), so an
    // estimate that is never corrected would permanently waste quota.
    const c = fakeClock();
    const l = new RateLimiter({ name: 'test', requestsPerMinute: 10, tokensPerMinute: 8000, now: c.now, sleep: c.sleep });
    const r = await l.reserve(3000);
    expect(l.snapshot().tokens).toBe(3000);
    r.settle(450);
    expect(l.snapshot().tokens).toBe(450);
  });

  it('ignores a second settle', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ name: 'test', requestsPerMinute: 10, tokensPerMinute: 8000, now: c.now, sleep: c.sleep });
    const r = await l.reserve(1000);
    r.settle(100);
    r.settle(9999);
    expect(l.snapshot().tokens).toBe(100);
  });

  it('serializes concurrent reservations so they cannot collectively overshoot', async () => {
    // Without admission serialization, parallel callers each see "there is
    // room" against the same pre-write state and all pass.
    const c = fakeClock();
    const l = new RateLimiter({ name: 'test', requestsPerMinute: 100, tokensPerMinute: 1000, now: c.now, sleep: c.sleep });
    await Promise.all(Array.from({ length: 10 }, () => l.reserve(100)));
    expect(l.snapshot().tokens).toBe(1000);
    expect(l.snapshot().tokens).toBeLessThanOrEqual(1000);
  });

  it('rejects a request larger than the entire per-minute budget', async () => {
    // Waiting could never let this through, so hanging would be a bug.
    const c = fakeClock();
    const l = new RateLimiter({ name: 'groq', requestsPerMinute: 30, tokensPerMinute: 8000, now: c.now, sleep: c.sleep });
    await expect(l.reserve(9000)).rejects.toThrow(/Shorten the prompt/);
  });

  it('throws rather than hanging when the daily quota is gone', async () => {
    const c = fakeClock();
    const l = new RateLimiter({
      name: 'gemini', requestsPerMinute: 100, tokensPerMinute: 100_000,
      requestsPerDay: 3, now: c.now, sleep: c.sleep,
    });
    await l.reserve(10);
    await l.reserve(10);
    await l.reserve(10);
    await expect(l.reserve(10)).rejects.toThrow(/daily quota exhausted/);
  });

  it('keeps daily usage after the per-minute window has rolled', async () => {
    const c = fakeClock();
    const l = new RateLimiter({
      name: 'test', requestsPerMinute: 10, tokensPerMinute: 1000,
      requestsPerDay: 100, now: c.now, sleep: c.sleep,
    });
    await l.reserve(100);
    c.advance(120_000);
    const snap = l.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.requestsToday).toBe(1);
    expect(snap.tokensToday).toBe(100);
  });
});
