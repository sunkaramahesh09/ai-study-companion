import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GroqProvider } from './groq.ts';
import { InvalidOutputError, type AiRequestRecord } from './types.ts';

/**
 * Failover and the empty-content guard are tested against a stubbed SDK call.
 * Provoking a real 429 would mean deliberately burning the 8000 TPM budget, and
 * the behaviour under test is ours, not Groq's.
 */

type Stub = ReturnType<typeof vi.fn>;

function makeProvider(create: Stub, records: AiRequestRecord[] = []) {
  const provider = new GroqProvider({
    apiKey: 'test',
    baseUrl: 'https://example.invalid/v1',
    primaryModel: 'openai/gpt-oss-120b',
    fallbackModel: 'openai/gpt-oss-20b',
    requestsPerMinute: 30,
    tokensPerMinute: 8000,
    requestsPerDay: 1000,
    tokensPerDay: 200_000,
    recordUsage: (r) => {
      records.push(r);
    },
  });
  // Replace the SDK's network call; everything above it is real.
  (provider as unknown as { client: { chat: { completions: { create: Stub } } } }).client = {
    chat: { completions: { create } },
  };
  return provider;
}

function completion(content: string, usage?: Partial<{ prompt_tokens: number; completion_tokens: number; reasoning: number; total_tokens: number }>) {
  return {
    choices: [{ message: { content }, finish_reason: content ? 'stop' : 'length' }],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 100,
      completion_tokens: usage?.completion_tokens ?? 50,
      total_tokens: usage?.total_tokens ?? 150,
      completion_tokens_details: { reasoning_tokens: usage?.reasoning ?? 10 },
    },
  };
}

function rateLimit() {
  const e = new Error('rate limited') as Error & { status: number };
  e.status = 429;
  return e;
}

const req = {
  feature: 'tutor_answer' as const,
  system: 'You are a tutor.',
  messages: [{ role: 'user' as const, content: 'Explain gradient descent.' }],
};

describe('GroqProvider', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('returns content and records a success row', async () => {
    const records: AiRequestRecord[] = [];
    const create = vi.fn().mockResolvedValue(completion('Gradient descent minimises loss.'));
    const p = makeProvider(create, records);

    const result = await p.generate(req);
    expect(result.text).toContain('Gradient descent');
    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(result.usedFallback).toBe(false);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'success', provider: 'groq', feature: 'tutor_answer', usedFallback: false });
  });

  it('reports reasoning tokens inside completion tokens', async () => {
    // The API bills reasoning as completion tokens, so the cost view must
    // reflect the billed number, not just visible output (D-016).
    const records: AiRequestRecord[] = [];
    const create = vi.fn().mockResolvedValue(completion('ok', { completion_tokens: 37, reasoning: 27 }));
    const p = makeProvider(create, records);
    const result = await p.generate(req);
    expect(result.usage.completionTokens).toBe(37);
    expect(result.usage.reasoningTokens).toBe(27);
    expect(records[0]!.completionTokens).toBe(37);
  });

  it('treats EMPTY content as invalid output, not as an empty answer', async () => {
    // Measured: max_tokens=10 spent 8 tokens reasoning and returned "". Letting
    // that through pushes "" into a JSON.parse that throws far from the cause.
    const records: AiRequestRecord[] = [];
    const create = vi.fn().mockResolvedValue(completion('', { completion_tokens: 10, reasoning: 8 }));
    const p = makeProvider(create, records);

    await expect(p.generate(req)).rejects.toBeInstanceOf(InvalidOutputError);
    expect(records[0]).toMatchObject({ status: 'invalid_output' });
    expect(records[0]!.errorMessage).toMatch(/empty content/i);
  });

  it('fails over primary -> fallback on a 429 retries could not clear', async () => {
    const records: AiRequestRecord[] = [];
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue(completion('answer from the smaller model'));
    const p = makeProvider(create, records);

    const result = await p.generate(req);
    expect(result.usedFallback).toBe(true);
    expect(result.model).toBe('openai/gpt-oss-20b');

    const statuses = records.map((r) => `${r.model}:${r.status}`);
    expect(statuses).toContain('openai/gpt-oss-120b:rate_limited');
    expect(statuses).toContain('openai/gpt-oss-20b:success');
  }, 30_000);

  it('does NOT fail over on a 400 — it would repeat a bad request on a second quota pool', async () => {
    const badRequest = new Error('invalid') as Error & { status: number };
    badRequest.status = 400;
    const create = vi.fn().mockRejectedValue(badRequest);
    const p = makeProvider(create);

    await expect(p.generate(req)).rejects.toMatchObject({ status: 400 });
    expect(create).toHaveBeenCalledTimes(1); // no retry, no failover
  });

  it('does not fail over when the caller already asked for the fallback tier', async () => {
    const create = vi.fn().mockRejectedValue(rateLimit());
    const p = makeProvider(create);
    await expect(p.generate({ ...req, tier: 'fallback' })).rejects.toMatchObject({ status: 429 });
    // 4 retry attempts on the fallback, and no escalation anywhere else.
    expect(create).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('raises max_tokens to the floor that leaves room for reasoning', async () => {
    const create = vi.fn().mockResolvedValue(completion('fine'));
    const p = makeProvider(create);
    await p.generate({ ...req, maxTokens: 10 });
    const sent = create.mock.calls[0]![0] as { max_completion_tokens: number };
    expect(sent.max_completion_tokens).toBeGreaterThanOrEqual(256);
  });

  it('passes reasoning_effort through as a cost lever', async () => {
    const create = vi.fn().mockResolvedValue(completion('fine'));
    const p = makeProvider(create);
    await p.generate({ ...req, reasoningEffort: 'low' });
    const sent = create.mock.calls[0]![0] as { reasoning_effort?: string };
    expect(sent.reasoning_effort).toBe('low');
  });

  it('keeps separate quota pools per tier', async () => {
    const create = vi.fn().mockResolvedValue(completion('ok'));
    const p = makeProvider(create);
    await p.generate(req);
    const snap = p.snapshot();
    expect(snap.primary.requests).toBe(1);
    expect(snap.fallback.requests).toBe(0);
  });

  it('never lets a usage-recorder failure break generation', async () => {
    const create = vi.fn().mockResolvedValue(completion('still works'));
    const p = new GroqProvider({
      apiKey: 'x', baseUrl: 'https://example.invalid/v1',
      primaryModel: 'm1', fallbackModel: 'm2',
      requestsPerMinute: 30, tokensPerMinute: 8000, requestsPerDay: 1000, tokensPerDay: 200_000,
      recordUsage: () => {
        throw new Error('database is down');
      },
    });
    (p as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    await expect(p.generate(req)).resolves.toMatchObject({ text: 'still works' });
  });
});
