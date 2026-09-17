import { describe, expect, it } from 'vitest';
import { ConceptExtractionSchema, dedupe, sampleChunks, type SourceChunk } from '../lib/concepts.ts';

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

  it('defaults to a budget that fits the worker fallback share', () => {
    // ~1500 tokens of material + a 900-token completion allowance lands near
    // 2400 estimated, inside the worker's 6000 TPM fallback pool (D-033).
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(i, 300));
    const used = sampleChunks(chunks).reduce((s, c) => s + c.tokenCount, 0);
    expect(used).toBeLessThanOrEqual(1500);
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
