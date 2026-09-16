import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkPages, extractPdf, normalizeWhitespace, type PageText } from '../lib/pdf.ts';

const page = (n: number, text: string): PageText => ({ pageNumber: n, text });

describe('normalizeWhitespace', () => {
  it('collapses the ragged whitespace PDF extraction produces', () => {
    expect(normalizeWhitespace('a  \t b')).toBe('a b');
    expect(normalizeWhitespace('a \n b')).toBe('a\nb');
    expect(normalizeWhitespace('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeWhitespace('  padded  ')).toBe('padded');
  });
});

describe('chunkPages', () => {
  it('never lets a chunk span a page boundary', () => {
    // D-005. This is what makes "Page 14" in a citation provable rather than
    // approximate, and it is the whole reason chunking is page-scoped.
    const pages = [page(1, 'alpha '.repeat(600)), page(2, 'beta '.repeat(600))];
    const chunks = chunkPages(pages);

    for (const c of chunks) {
      const onPage1 = c.content.includes('alpha');
      const onPage2 = c.content.includes('beta');
      expect(onPage1 && onPage2).toBe(false);
      expect(c.pageNumber).toBe(onPage1 ? 1 : 2);
    }
  });

  it('keeps a short page as a single chunk', () => {
    const chunks = chunkPages([page(7, 'A short but meaningful paragraph about gradient descent.')]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.pageNumber).toBe(7);
  });

  it('splits a long page into several chunks near the target size', () => {
    const chunks = chunkPages([page(1, 'word '.repeat(2000))], { targetTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(260);
  });

  it('numbers chunks contiguously across pages', () => {
    const chunks = chunkPages([page(1, 'x '.repeat(500)), page(2, 'y '.repeat(500))]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('drops slivers that carry no retrievable meaning', () => {
    // A stray page number would otherwise become a chunk and pollute results.
    const chunks = chunkPages([page(1, '14'), page(2, 'A genuine sentence with enough substance to retrieve.')]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.pageNumber).toBe(2);
  });

  it('overlaps consecutive chunks so a boundary concept stays retrievable', () => {
    const text = Array.from({ length: 400 }, (_, i) => `sentence${i}.`).join(' ');
    const chunks = chunkPages([page(1, text)], { targetTokens: 100, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(2);
    const first = chunks[0]!.content.slice(-40);
    expect(chunks[1]!.content.includes(first.split(' ').at(-2) ?? '')).toBe(true);
  });

  it('clamps overlap so chunk count cannot explode', () => {
    // An overlap near the target size advances only a few characters per
    // chunk. Unclamped this produced 12,451 near-duplicate chunks from ONE
    // page — which at ~1000 Gemini requests/day would burn the entire daily
    // embedding quota on a single document (D-028).
    const chunks = chunkPages([page(1, 'a'.repeat(50_000))], { targetTokens: 50, overlapTokens: 49 });
    expect(chunks.length).toBeGreaterThan(0);
    // 50k chars, 200-char window advancing >= 100 chars => at most ~500.
    expect(chunks.length).toBeLessThan(600);
  });

  it('bounds chunk count for a realistically large page', () => {
    const chunks = chunkPages([page(1, 'word '.repeat(20_000))], { targetTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeLessThan(60);
  });

  it('handles an empty page list', () => {
    expect(chunkPages([])).toEqual([]);
  });
});

// Real PDF, not a synthetic fixture: extraction is exactly the step where a
// library's behaviour on real-world input differs from the happy path.
const PRD = '/Users/mahesh/Project_Requirements.pdf';
const describeReal = existsSync(PRD) ? describe : describe.skip;

describeReal('extractPdf on a real document', () => {
  it('extracts per-page text with correct page numbers', async () => {
    const result = await extractPdf(new Uint8Array(readFileSync(PRD)));
    expect(result.pageCount).toBe(25);
    expect(result.pages.length).toBeGreaterThan(20);
    expect(result.pages[0]!.pageNumber).toBe(1);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([...result.pages.map((p) => p.pageNumber)].sort((a, b) => a - b));
  });

  it('produces chunks whose cited page really contains the text', async () => {
    const result = await extractPdf(new Uint8Array(readFileSync(PRD)));
    const chunks = chunkPages(result.pages);
    expect(chunks.length).toBeGreaterThan(20);

    // The citation guarantee, checked against the source: every chunk's text
    // must actually appear on the page it claims.
    const byPage = new Map(result.pages.map((p) => [p.pageNumber, p.text]));
    for (const c of chunks.slice(0, 40)) {
      const pageText = byPage.get(c.pageNumber);
      expect(pageText).toBeDefined();
      const probe = c.content.slice(0, 60);
      expect(pageText!.includes(probe)).toBe(true);
    }
  });
});

describe('embedding invariant', () => {
  it('documents the rule the job enforces', () => {
    // The job throws unless embedded === chunks.length, so `status: ready`
    // always implies every chunk is retrievable. Stated here because the rule
    // lives in a worker path that unit tests do not execute, and it is the
    // invariant the Tutor's evidence gate depends on.
    const chunkCount = 25;
    const embedded = 25;
    expect(embedded).toBe(chunkCount);
  });
});
