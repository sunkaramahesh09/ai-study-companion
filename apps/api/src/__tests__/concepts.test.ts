import { describe, expect, it } from 'vitest';
import { estimateRequestTokens } from '@asc/ai';
import {
  ConceptExtractionSchema,
  dedupe,
  extractionBudget,
  sampleChunks,
  type SourceChunk,
} from '../lib/concepts.ts';

const chunk = (i: number, tokens = 100): SourceChunk => ({
  chunkIndex: i,
  pageNumber: i + 1,
  content: `content ${i}`,
  tokenCount: tokens,
});

describe('sampleChunks', () => {
  it('returns everything when the document already fits', () => {
    const chunks = [chunk(0), chunk(1), chunk(2)];
    expect(sampleChunks(chunks, 2000)).toHaveLength(3);
  });

  it('respects whatever budget it is handed', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(i, 300));
    for (const budget of [600, 1500, 4000]) {
      const used = sampleChunks(chunks, budget).reduce((s, c) => s + c.tokenCount, 0);
      expect(used).toBeLessThanOrEqual(budget);
    }
  });

  it('stays inside the token budget for a large document', () => {
    const chunks = Array.from({ length: 300 }, (_, i) => chunk(i, 800));
    const picked = sampleChunks(chunks, 2000);
    const used = picked.reduce((s, c) => s + c.tokenCount, 0);
    expect(used).toBeLessThanOrEqual(2000);
    expect(picked.length).toBeGreaterThan(0);
  });

  it('spreads samples across the document rather than taking a prefix', () => {
    // Opening pages are usually front matter. A prefix would extract concepts
    // from the table of contents and miss what the document is about.
    const chunks = Array.from({ length: 100 }, (_, i) => chunk(i, 200));
    const picked = sampleChunks(chunks, 2000);
    const indexes = picked.map((c) => c.chunkIndex);
    expect(Math.max(...indexes)).toBeGreaterThan(50);
    expect(Math.min(...indexes)).toBeLessThan(20);
  });

  it('never repeats a chunk', () => {
    const chunks = Array.from({ length: 40 }, (_, i) => chunk(i, 10));
    const picked = sampleChunks(chunks, 200);
    expect(new Set(picked.map((c) => c.chunkIndex)).size).toBe(picked.length);
  });

  it('handles an empty document', () => {
    expect(sampleChunks([], 2000)).toEqual([]);
  });

  it('keeps at least one chunk even when a single chunk exceeds the budget', () => {
    expect(sampleChunks([chunk(0, 9999)], 2000)).toHaveLength(1);
  });
});

describe('ConceptExtractionSchema', () => {
  const valid = {
    concepts: [{ name: 'Gradient descent', description: 'An iterative optimisation method for minimising loss.' }],
  };

  it('accepts a well-formed extraction', () => {
    expect(ConceptExtractionSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty concept list', () => {
    // Persisting zero concepts silently would leave quizzes with nothing to
    // select from and no signal about why.
    expect(ConceptExtractionSchema.safeParse({ concepts: [] }).success).toBe(false);
  });

  it('rejects a blank or one-character name', () => {
    expect(ConceptExtractionSchema.safeParse({ concepts: [{ name: '', description: 'x'.repeat(20) }] }).success).toBe(false);
    expect(ConceptExtractionSchema.safeParse({ concepts: [{ name: 'A', description: 'x'.repeat(20) }] }).success).toBe(false);
  });

  it('rejects a missing description', () => {
    expect(ConceptExtractionSchema.safeParse({ concepts: [{ name: 'Valid name' }] }).success).toBe(false);
  });

  it('rejects an implausibly long list', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `Concept ${i}`, description: 'x'.repeat(20) }));
    expect(ConceptExtractionSchema.safeParse({ concepts: many }).success).toBe(false);
  });

  it('trims whitespace rather than storing a padded name', () => {
    const parsed = ConceptExtractionSchema.parse({
      concepts: [{ name: '  Backpropagation  ', description: '  Computes gradients through the network.  ' }],
    });
    expect(parsed.concepts[0]!.name).toBe('Backpropagation');
  });
});

describe('dedupe', () => {
  it('collapses concepts differing only by case or punctuation', () => {
    // concepts is unique on (project_id, name), so near-duplicates would split
    // one learner's mastery across two rows.
    const out = dedupe([
      { name: 'Gradient Descent', description: 'a' },
      { name: 'gradient descent', description: 'b' },
      { name: 'Gradient-Descent!', description: 'c' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('Gradient Descent');
  });

  it('keeps genuinely different concepts', () => {
    const out = dedupe([
      { name: 'Gradient descent', description: 'a' },
      { name: 'Stochastic gradient descent', description: 'b' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('drops an entry whose name is only punctuation', () => {
    expect(dedupe([{ name: '---', description: 'x' }])).toHaveLength(0);
  });
});

/**
 * These exist because the old version of this suite did not.
 *
 * It asserted that `sampleChunks` respected its own 1500-token default, which
 * was true and useless: nothing checked that the resulting REQUEST fit the
 * limiter it would be admitted through. When the quota shares were rebalanced
 * the worker's fallback ceiling fell to 2000, the request estimated at 2156,
 * and the limiter rejected it permanently — a project stuck at zero concepts
 * behind a material row that said "ready". Green suite throughout (D-088).
 *
 * So these assert against the REAL estimator, not against our own arithmetic.
 */
describe('extractionBudget', () => {
  // What extractConcepts actually sends, so the estimate here is the estimate
  // the limiter will compute.
  const estimateFor = (budget: { sampleTokens: number; completionTokens: number }) =>
    estimateRequestTokens({
      // The system prompt is ~1.1k characters; the sampled material is rendered
      // into the user message at roughly 4 characters per token.
      system: 'x'.repeat(1_100),
      messages: [{ content: 'x'.repeat(budget.sampleTokens * 4) }],
      maxTokens: budget.completionTokens,
      reasoningEffort: 'low',
    });

  it('keeps the request under the ceiling it will be admitted through', () => {
    // 2000 = the share that broke it. 3200 = the worker's share now.
    for (const ceiling of [1_000, 1_500, 2_000, 3_200, 6_000, 8_000]) {
      expect(estimateFor(extractionBudget(ceiling))).toBeLessThanOrEqual(ceiling);
    }
  });

  it('degrades on a small ceiling instead of producing an impossible request', () => {
    // The failure mode being prevented: a budget that cannot fit is not a slow
    // request, it is one the limiter refuses forever.
    const tight = extractionBudget(1_000);
    expect(tight.sampleTokens).toBeGreaterThan(0);
    expect(estimateFor(tight)).toBeLessThanOrEqual(1_000);
  });

  it('never drops the completion allowance below the empty-string floor', () => {
    // Under ~600, gpt-oss spends the whole allowance on reasoning and returns
    // "" with no error (D-016). A truncation is worse than a small sample.
    for (const ceiling of [500, 1_000, 8_000]) {
      expect(extractionBudget(ceiling).completionTokens).toBeGreaterThanOrEqual(600);
    }
  });

  it('gives a bigger ceiling a bigger sample', () => {
    expect(extractionBudget(6_000).sampleTokens).toBeGreaterThan(
      extractionBudget(2_000).sampleTokens,
    );
  });
});
