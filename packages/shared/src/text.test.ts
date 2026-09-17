import { describe, expect, it } from 'vitest';
import { containsNormalised, normaliseForComparison } from './text.ts';

describe('normaliseForComparison', () => {
  it('matches a non-breaking hyphen against an ASCII one', () => {
    // The real case: a production Tutor answer read "about thirty‑two ATP"
    // (U+2011) and failed an assertion written as "thirty-two".
    expect(containsNormalised('a net of about thirty‑two ATP', 'thirty-two')).toBe(true);
  });

  it.each([
    ['‐', 'hyphen'],
    ['‒', 'figure dash'],
    ['–', 'en dash'],
    ['—', 'em dash'],
    ['−', 'minus sign'],
  ])('treats %s (%s) as an ASCII hyphen', (dash) => {
    expect(containsNormalised(`thirty${dash}two`, 'thirty-two')).toBe(true);
  });

  it('matches curly quotes against straight ones', () => {
    expect(containsNormalised('the cell’s membrane', "the cell's membrane")).toBe(true);
    expect(containsNormalised('he said “yes”', 'he said "yes"')).toBe(true);
  });

  it('matches a non-breaking space against an ordinary one', () => {
    expect(containsNormalised('32 ATP', '32 ATP')).toBe(true);
  });

  it('collapses runs of whitespace, including newlines', () => {
    expect(containsNormalised('thirty-two\n\n   ATP', 'thirty-two ATP')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(containsNormalised('RuBisCO fixes carbon', 'rubisco')).toBe(true);
  });

  it('matches an ellipsis character against three dots', () => {
    expect(containsNormalised('and so on…', 'and so on...')).toBe(true);
  });

  it('still says no when the content genuinely differs', () => {
    // Normalisation must not become a way of matching anything.
    expect(containsNormalised('a net of about two ATP', 'thirty-two')).toBe(false);
    expect(containsNormalised('glycolysis happens in the cytoplasm', 'mitochondria')).toBe(false);
  });

  it('leaves plain ASCII alone apart from case and spacing', () => {
    expect(normaliseForComparison('  Thirty-Two   ATP ')).toBe('thirty-two atp');
  });
});
