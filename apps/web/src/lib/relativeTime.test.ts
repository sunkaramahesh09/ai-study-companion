import { describe, expect, it } from 'vitest';
import { relativeDue } from './relativeTime.ts';

const NOW = new Date('2026-09-18T12:00:00Z').getTime();
const inMs = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeDue', () => {
  it('says a card is due now rather than counting backwards', () => {
    expect(relativeDue(inMs(0), NOW)).toBe('now');
    expect(relativeDue(inMs(-5 * DAY), NOW)).toBe('now');
  });

  it('keeps the relearning step in minutes', () => {
    // The 10-minute step is the whole reason this is not a date.
    expect(relativeDue(inMs(10 * MIN), NOW)).toBe('in 10 min');
  });

  it('agrees with itself at every boundary', () => {
    expect(relativeDue(inMs(59 * MIN), NOW)).toBe('in 59 min');
    expect(relativeDue(inMs(60 * MIN), NOW)).toBe('in 1 hour');
    expect(relativeDue(inMs(23 * HOUR), NOW)).toBe('in 23 hours');
    expect(relativeDue(inMs(24 * HOUR), NOW)).toBe('in 1 day');
    expect(relativeDue(inMs(3 * DAY), NOW)).toBe('in 3 days');
  });

  it('never writes "in 1 days"', () => {
    for (const ms of [60 * MIN, 24 * HOUR]) {
      expect(relativeDue(inMs(ms), NOW)).not.toMatch(/\b1 \w+s\b/);
    }
  });

  it('does not print NaN when handed something that is not a date', () => {
    expect(relativeDue('not a date', NOW)).toBe('unknown');
  });
});
