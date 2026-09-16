import { extractText, getDocumentProxy } from 'unpdf';

export type PageText = { pageNumber: number; text: string };

export type ExtractedPdf = {
  pageCount: number;
  pages: PageText[];
  /** Pages that yielded no extractable text — almost always scanned images. */
  emptyPages: number[];
};

/**
 * Extracts text per page.
 *
 * Per page, not merged, because citations must name an exact page (PRD §7) and
 * a merged blob makes that a guess. Text-layer PDFs only: there is no OCR, so a
 * scanned document produces empty pages. That is a documented limitation
 * (D-027), and the caller reports it to the user rather than silently indexing
 * nothing.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  const pages: PageText[] = [];
  const emptyPages: number[] = [];

  (text as string[]).forEach((raw, index) => {
    const pageNumber = index + 1;
    const cleaned = normalizeWhitespace(raw ?? '');
    if (cleaned.length === 0) {
      emptyPages.push(pageNumber);
      return;
    }
    pages.push({ pageNumber, text: cleaned });
  });

  return { pageCount: totalPages, pages, emptyPages };
}

/**
 * PDF text extraction produces ragged whitespace — hard line breaks mid
 * sentence, runs of spaces from column layout. Left alone this wastes tokens in
 * every retrieved chunk, and the 8000 TPM ceiling makes that expensive.
 */
export function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type Chunk = {
  pageNumber: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
};

/** Matches the estimator in @asc/ai — approximate by design, see tokens.ts. */
const CHARS_PER_TOKEN = 4;
const estimate = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

export type ChunkOptions = {
  targetTokens?: number;
  overlapTokens?: number;
  minTokens?: number;
};

/**
 * Splits extracted pages into retrieval units.
 *
 * A chunk NEVER spans a page boundary (D-005). That costs some context when a
 * concept straddles a page break, but it is what makes a citation of "Page 14"
 * provably the page the text came from rather than approximately right. Getting
 * citations wrong would undermine the feature the PRD calls a core evaluation
 * requirement.
 *
 * Splitting prefers paragraph breaks, then sentence ends, then a hard cut, so
 * chunks tend to begin and end at something a reader would recognise.
 */
export function chunkPages(pages: PageText[], options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? 800;
  const overlapTokens = options.overlapTokens ?? 100;
  const minTokens = options.minTokens ?? 12;

  const targetChars = targetTokens * CHARS_PER_TOKEN;
  // Clamp overlap to half the target so every chunk advances at least 50% of a
  // window. Without this, an overlap approaching the target advances a handful
  // of characters per chunk: a single page produced 12,451 near-duplicate
  // chunks in testing. That is not just wasteful — at ~1000 Gemini requests per
  // day, one misconfigured document would exhaust the entire daily embedding
  // quota. See D-028.
  const overlapChars = Math.min(overlapTokens, Math.floor(targetTokens / 2)) * CHARS_PER_TOKEN;

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    for (const piece of splitPage(page.text, targetChars, overlapChars)) {
      const content = piece.trim();
      // Drop slivers — a page number or a stray header carries no retrievable
      // meaning and would pollute similarity results.
      if (estimate(content) < minTokens) continue;
      chunks.push({
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
        content,
        tokenCount: estimate(content),
      });
    }
  }

  return chunks;
}

function splitPage(text: string, targetChars: number, overlapChars: number): string[] {
  if (text.length <= targetChars) return [text];

  const out: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + targetChars);
    let cut = end;

    if (end < text.length) {
      // Prefer a paragraph break in the last third of the window, then a
      // sentence end, before resorting to a hard cut mid-word.
      const window = text.slice(start, end);
      const searchFrom = Math.floor(window.length * 0.6);
      const para = window.lastIndexOf('\n\n', window.length);
      const sentence = window.search(/[.!?]\s[^]*$/);
      const lastSentence = lastSentenceEnd(window, searchFrom);

      if (para > searchFrom) cut = start + para;
      else if (lastSentence > searchFrom) cut = start + lastSentence;
      else if (sentence > searchFrom) cut = start + sentence + 1;
    }

    out.push(text.slice(start, cut));
    if (cut >= text.length) break;

    // Overlap keeps a concept that lands on a boundary retrievable from either
    // side. Always advance, so a pathological input cannot loop forever.
    const next = Math.max(start + 1, cut - overlapChars);
    start = next;
  }

  return out;
}

function lastSentenceEnd(window: string, minIndex: number): number {
  for (let i = window.length - 1; i > minIndex; i--) {
    const ch = window[i];
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(window[i + 1] ?? ' ')) {
      return i + 1;
    }
  }
  return -1;
}
