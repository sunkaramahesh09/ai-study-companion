import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbeddingProvider, normalize } from './gemini.ts';
import type { AiRequestRecord } from './types.ts';

const L2 = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0));

function fakeEmbeddings(count: number, dims: number, scale = 0.581) {
  // Mirrors the real measurement: Gemini's 768-dim output arrives with an L2
  // norm of ~0.581, not 1.0 (D-017).
  return {
    embeddings: Array.from({ length: count }, () => {
      const raw = Array.from({ length: dims }, (_, i) => Math.sin(i + 1));
      const n = L2(raw);
      return { values: raw.map((v) => (v / n) * scale) };
    }),
  };
}

function makeProvider(fetchImpl: typeof fetch, records: AiRequestRecord[] = [], overrides = {}) {
  vi.stubGlobal('fetch', fetchImpl);
  return new GeminiEmbeddingProvider({
    apiKey: 'test',
    model: 'gemini-embedding-001',
    dimensions: 768,
    requestsPerMinute: 100,
    requestsPerDay: 1000,
    batchSize: 20,
    batchDelayMs: 0,
    recordUsage: (r) => {
      records.push(r);
    },
    ...overrides,
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('normalize', () => {
  it('scales a vector to unit length', () => {
    expect(L2(normalize([3, 4]))).toBeCloseTo(1, 10);
    expect(L2(normalize([0.5, 0.1, -0.3]))).toBeCloseTo(1, 10);
  });

  it('preserves direction', () => {
    const n = normalize([3, 4]);
    expect(n[0]! / n[1]!).toBeCloseTo(3 / 4, 10);
  });

  it('returns a zero vector unchanged rather than emitting NaNs', () => {
    // NaNs here would poison every distance computation downstream.
    const z = normalize([0, 0, 0]);
    expect(z).toEqual([0, 0, 0]);
    expect(z.some(Number.isNaN)).toBe(false);
  });
});

describe('GeminiEmbeddingProvider', () => {
  it('normalizes what the API returns, since Gemini does not', async () => {
    const p = makeProvider(vi.fn().mockResolvedValue(ok(fakeEmbeddings(2, 768))) as unknown as typeof fetch);
    const { vectors } = await p.embed({ texts: ['a', 'b'] });
    expect(vectors).toHaveLength(2);
    for (const v of vectors) expect(L2(v)).toBeCloseTo(1, 6);
  });

  it('requests the configured dimensionality', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(fakeEmbeddings(1, 768)));
    const p = makeProvider(fetchMock as unknown as typeof fetch);
    await p.embed({ texts: ['x'] });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.requests[0].outputDimensionality).toBe(768);
  });

  it('forwards taskType so query and document embeddings match correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(fakeEmbeddings(1, 768)));
    const p = makeProvider(fetchMock as unknown as typeof fetch);
    await p.embed({ texts: ['x'], taskType: 'RETRIEVAL_QUERY' });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.requests[0].taskType).toBe('RETRIEVAL_QUERY');
  });

  it('batches to respect the RPM ceiling', async () => {
    // 45 chunks at batch size 20 must be 3 calls, not 45.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(fakeEmbeddings(20, 768)))
      .mockResolvedValueOnce(ok(fakeEmbeddings(20, 768)))
      .mockResolvedValueOnce(ok(fakeEmbeddings(5, 768)));
    const p = makeProvider(fetchMock as unknown as typeof fetch);
    const { vectors, calls } = await p.embed({ texts: Array.from({ length: 45 }, (_, i) => `t${i}`) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls).toBe(3);
    expect(vectors).toHaveLength(45);
  });

  it('rejects a dimension mismatch instead of writing a bad vector', async () => {
    // The column is vector(768); a 1536-dim value would fail at insert time
    // with a far less obvious error.
    const p = makeProvider(vi.fn().mockResolvedValue(ok(fakeEmbeddings(1, 1536))) as unknown as typeof fetch);
    await expect(p.embed({ texts: ['x'] })).rejects.toThrow(/expected 768/);
  });

  it('rejects a count mismatch, which would misalign every later chunk', async () => {
    const p = makeProvider(vi.fn().mockResolvedValue(ok(fakeEmbeddings(2, 768))) as unknown as typeof fetch);
    await expect(p.embed({ texts: ['a', 'b', 'c'] })).rejects.toThrow(/2 embeddings for 3 inputs/);
  });

  it('retries RESOURCE_EXHAUSTED then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 }))
      .mockResolvedValue(ok(fakeEmbeddings(1, 768)));
    const p = makeProvider(fetchMock as unknown as typeof fetch);
    const { vectors } = await p.embed({ texts: ['x'] });
    expect(vectors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('records a usage row per embed call', async () => {
    const records: AiRequestRecord[] = [];
    const p = makeProvider(vi.fn().mockResolvedValue(ok(fakeEmbeddings(1, 768))) as unknown as typeof fetch, records);
    await p.embed({ texts: ['x'], projectId: 'p1', userId: 'u1' });
    expect(records[0]).toMatchObject({ provider: 'gemini', feature: 'embedding', status: 'success', projectId: 'p1' });
  });

  it('short-circuits on an empty input list without calling the API', async () => {
    const fetchMock = vi.fn();
    const p = makeProvider(fetchMock as unknown as typeof fetch);
    const result = await p.embed({ texts: [] });
    expect(result.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
