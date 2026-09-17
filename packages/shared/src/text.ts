/**
 * Text normalisation for comparing model output against expected content.
 *
 * Models emit typographic Unicode where a developer writes ASCII: a
 * non-breaking hyphen (U+2011) in "thirty‑two", a right single quote in
 * "cell's", an en dash between ranges, a non-breaking space. Every one of
 * those makes a literal `includes('thirty-two')` fail against an answer that
 * is completely correct.
 *
 * That matters more than it sounds, because the code doing this comparing is
 * the EVALUATION suite and the production rehearsal. A brittle match there
 * does not produce a cosmetic glitch — it produces a red result for working
 * behaviour, which is the failure mode most likely to be believed and acted on.
 *
 * Found in production: a Tutor answer reading "a net of about thirty‑two ATP"
 * failed an assertion written as `thirty-two`. See D-057.
 */
export function normaliseForComparison(text: string): string {
  return (
    text
      // Every dash-like character becomes an ASCII hyphen: hyphen, non-breaking
      // hyphen, figure dash, en dash, em dash, horizontal bar, minus sign.
      .replace(/[‐‑‒–—―−]/g, '-')
      // Curly quotes and primes become their ASCII equivalents.
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      // Every space-like character, including non-breaking, becomes a space.
      .replace(/[    - 　]/g, ' ')
      // Ellipsis to three dots, so "..." and "…" compare equal.
      .replace(/…/g, '...')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/** Does `haystack` contain `needle`, ignoring typographic variation? */
export function containsNormalised(haystack: string, needle: string): boolean {
  return normaliseForComparison(haystack).includes(normaliseForComparison(needle));
}
