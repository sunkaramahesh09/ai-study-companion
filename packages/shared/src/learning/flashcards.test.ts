import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EASE,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  RELEARN_MINUTES,
  dueCards,
  newCardSchedule,
  nextDueAt,
  reviewCard,
  selectDeckConcepts,
  type CardSchedule,
  type ReviewRating,
} from './flashcards.ts';
import type { ConceptCandidate } from './selection.ts';
import type { MasteryState } from './mastery.ts';

const T0 = new Date('2026-09-01T09:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

/** Reviews a card repeatedly, advancing the clock to each due date in turn. */
function drill(rating: ReviewRating, times: number, from = newCardSchedule(T0)): CardSchedule {
  let s = from;
  for (let i = 0; i < times; i += 1) s = reviewCard(s, rating, s.dueAt);
  return s;
}

describe('reviewCard', () => {
  it('starts a new card due immediately', () => {
    const s = newCardSchedule(T0);
    expect(s.dueAt.getTime()).toBe(T0.getTime());
    expect(s.reps).toBe(0);
    expect(s.ease).toBe(DEFAULT_EASE);
  });

  it('brings a forgotten card back within the same sitting, not tomorrow', () => {
    const s = reviewCard(newCardSchedule(T0), 'again', T0);
    expect(s.dueAt).toEqual(minutes(RELEARN_MINUTES));
    expect(s.intervalDays).toBe(0);
  });

  it('counts a lapse and resets the streak without erasing the history', () => {
    const learned = drill('good', 3);
    expect(learned.reps).toBe(3);

    const lapsed = reviewCard(learned, 'again', learned.dueAt);
    expect(lapsed.reps).toBe(0);
    expect(lapsed.lapses).toBe(1);
    // The card is still known to be a hard one.
    expect(lapsed.ease).toBeLessThan(learned.ease);
  });

  it('grows the interval on each success instead of repeating a fixed gap', () => {
    const first = reviewCard(newCardSchedule(T0), 'good', T0);
    const second = reviewCard(first, 'good', first.dueAt);
    const third = reviewCard(second, 'good', second.dueAt);

    expect(first.intervalDays).toBe(1);
    expect(second.intervalDays).toBe(3);
    expect(third.intervalDays).toBeGreaterThan(second.intervalDays);
  });

  it('never shrinks an interval for admitting a card was hard', () => {
    // The failure this guards: `interval * 1.2` on a 0-day card leaves it at 0,
    // so a learner rating "hard" would see the card again immediately and the
    // deck would never progress.
    let s = newCardSchedule(T0);
    for (let i = 0; i < 6; i += 1) {
      const next = reviewCard(s, 'hard', s.dueAt);
      expect(next.intervalDays).toBeGreaterThan(s.intervalDays);
      s = next;
    }
  });

  it('moves easy cards out faster than good ones', () => {
    const good = drill('good', 4);
    const easy = drill('easy', 4);
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays);
    expect(easy.ease).toBeGreaterThan(good.ease);
  });

  it('keeps ease inside its bounds however the learner rates', () => {
    expect(drill('easy', 30).ease).toBeLessThanOrEqual(MAX_EASE);
    // 'hard' never resets reps, so this is 30 consecutive ease reductions.
    expect(drill('hard', 30).ease).toBeGreaterThanOrEqual(MIN_EASE);
  });

  it('caps the interval so a deck stays a study tool', () => {
    const saturated = drill('easy', 40);
    expect(saturated.intervalDays).toBe(MAX_INTERVAL_DAYS);

    // And the cap reaches dueAt, not just the stored number: reviewing at a
    // known instant must land exactly MAX_INTERVAL_DAYS later.
    const next = reviewCard(saturated, 'easy', T0);
    expect(next.dueAt).toEqual(days(MAX_INTERVAL_DAYS));
  });

  it('is pure — the same schedule and rating always give the same answer', () => {
    const s = drill('good', 2);
    const a = reviewCard(s, 'good', days(10));
    const b = reviewCard(s, 'good', days(10));
    expect(a).toEqual(b);
    // And the input is untouched.
    expect(s.reps).toBe(2);
  });

  it('rounds to what the column can actually store', () => {
    // interval_days is numeric(6,2); a value with more precision than that
    // would be silently rounded by Postgres and the row would then disagree
    // with the dueAt computed from it here.
    let s = newCardSchedule(T0);
    for (let i = 0; i < 12; i += 1) {
      s = reviewCard(s, 'good', s.dueAt);
      expect(Math.round(s.intervalDays * 100)).toBe(s.intervalDays * 100);
    }
  });
});

describe('dueCards', () => {
  const deck = [
    { id: 'later', dueAt: days(3) },
    { id: 'overdue', dueAt: days(-7) },
    { id: 'just-due', dueAt: days(-0.01) },
  ];

  it('shows the most overdue card first', () => {
    expect(dueCards(deck, T0).map((c) => c.id)).toEqual(['overdue', 'just-due']);
  });

  it('leaves cards that are not due yet out of the queue', () => {
    expect(dueCards(deck, T0).some((c) => c.id === 'later')).toBe(false);
  });

  it('answers when the deck comes back once nothing is due', () => {
    expect(nextDueAt(deck, T0)).toEqual(days(3));
    expect(nextDueAt([], T0)).toBeNull();
  });

  it('respects a limit without reordering', () => {
    expect(dueCards(deck, T0, 1).map((c) => c.id)).toEqual(['overdue']);
  });
});

describe('selectDeckConcepts', () => {
  const mastery = (score: number, evidenceCount: number): MasteryState => ({
    score,
    evidenceCount,
    lastEvidenceAt: evidenceCount > 0 ? days(-1) : null,
  });

  const candidate = (
    conceptId: string,
    score: number,
    evidenceCount = 6,
  ): ConceptCandidate => ({
    conceptId,
    name: conceptId,
    mastery: mastery(score, evidenceCount),
    recentMistakes: 0,
    timesAsked: 3,
    lastAskedAt: days(-2),
  });

  it('builds the deck around the weakest concepts', () => {
    const picked = selectDeckConcepts(
      [candidate('strong', 0.9), candidate('weak', 0.15), candidate('middling', 0.55)],
      T0,
      2,
    );
    expect(picked.map((p) => p.conceptId)).toContain('weak');
    expect(picked.map((p) => p.conceptId)).not.toContain('strong');
  });

  it('carries the reason each concept was chosen', () => {
    const [top] = selectDeckConcepts([candidate('weak', 0.1)], T0, 1);
    expect(top!.signals.need).toBeGreaterThan(0.5);
    expect(top!.score).toBeGreaterThan(0);
  });

  it('asks for more cards than there are concepts without inventing any', () => {
    expect(selectDeckConcepts([candidate('only', 0.4)], T0, 5)).toHaveLength(1);
    expect(selectDeckConcepts([], T0, 5)).toHaveLength(0);
    expect(selectDeckConcepts([candidate('only', 0.4)], T0, 0)).toHaveLength(0);
  });
});
