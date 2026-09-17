import { describe, expect, it } from 'vitest';
import { PRIOR_MASTERY, replayMastery, type MasteryState } from './mastery.ts';
import {
  DEFAULT_WEIGHTS,
  emptyMastery,
  scoreConcept,
  selectDifficulty,
  selectNextQuestion,
  type ConceptCandidate,
} from './selection.ts';

const T0 = new Date('2026-09-17T10:00:00Z');
const minsAgo = (n: number) => new Date(T0.getTime() - n * 60_000);
const daysAgo = (n: number) => new Date(T0.getTime() - n * 86_400_000);

const mastery = (score: number, evidenceCount = 5, at: Date | null = daysAgo(1)): MasteryState => ({
  score,
  evidenceCount,
  lastEvidenceAt: at,
});

const candidate = (over: Partial<ConceptCandidate> & { conceptId: string }): ConceptCandidate => ({
  name: over.conceptId,
  mastery: mastery(0.5),
  recentMistakes: 0,
  timesAsked: 3,
  lastAskedAt: daysAgo(1),
  ...over,
});

describe('selectDifficulty', () => {
  it('aims below the learner rather than at even money', () => {
    // 0.7 target: genuinely a test, but not demoralising.
    const easy = selectDifficulty(mastery(0.2, 10), T0);
    const mid = selectDifficulty(mastery(0.5, 10), T0);
    const hard = selectDifficulty(mastery(0.9, 10), T0);
    expect(easy).toBeLessThan(mid);
    expect(mid).toBeLessThan(hard);
  });

  it('always returns a valid 1..5 difficulty', () => {
    for (const s of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const d = selectDifficulty(mastery(s, 10), T0);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(5);
      expect(Number.isInteger(d)).toBe(true);
    }
  });

  it('avoids the extremes when there is almost no evidence', () => {
    // An opening question at 1 or 5 measures little and reads badly.
    expect(selectDifficulty(mastery(0.99, 0, null), T0)).toBeLessThanOrEqual(4);
    expect(selectDifficulty(mastery(0.01, 0, null), T0)).toBeGreaterThanOrEqual(2);
  });

  it('is NOT driven by the last answer', () => {
    // The PRD rejects "wrong -> easy, correct -> hard" (§9). A single answer
    // barely moves mastery, so it barely moves difficulty.
    const established = replayMastery(
      Array.from({ length: 12 }, (_, i) => ({ correctness: 1, difficulty: 4, answeredAt: daysAgo(12 - i) })),
    );
    const before = selectDifficulty(established, T0);

    const afterOneMiss = replayMastery(
      [{ correctness: 0, difficulty: 4, answeredAt: T0 }],
      established,
    );
    const after = selectDifficulty(afterOneMiss, T0);

    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  });
});

describe('scoreConcept signals', () => {
  it('scores a weak concept above a strong one, all else equal', () => {
    const weak = scoreConcept(candidate({ conceptId: 'weak', mastery: mastery(0.2) }), T0);
    const strong = scoreConcept(candidate({ conceptId: 'strong', mastery: mastery(0.9) }), T0);
    expect(weak.score).toBeGreaterThan(strong.score);
  });

  it('values an unassessed concept even though its prior looks average', () => {
    // Without this the system would never establish what the learner knows
    // outside the first concept it happened to test.
    const unknown = scoreConcept(candidate({ conceptId: 'unknown', mastery: emptyMastery() }), T0);
    const known = scoreConcept(
      candidate({ conceptId: 'known', mastery: mastery(PRIOR_MASTERY, 12) }),
      T0,
    );
    expect(unknown.signals.uncertainty).toBeGreaterThan(known.signals.uncertainty);
    expect(unknown.score).toBeGreaterThan(known.score);
  });

  it('boosts a concept with recent mistakes', () => {
    const clean = scoreConcept(candidate({ conceptId: 'a', recentMistakes: 0 }), T0);
    const missed = scoreConcept(candidate({ conceptId: 'b', recentMistakes: 3 }), T0);
    expect(missed.score).toBeGreaterThan(clean.score);
  });

  it('saturates the mistake signal so one bad session does not pin the learner', () => {
    const three = scoreConcept(candidate({ conceptId: 'a', recentMistakes: 3 }), T0);
    const twenty = scoreConcept(candidate({ conceptId: 'a', recentMistakes: 20 }), T0);
    expect(twenty.signals.mistakes).toBe(three.signals.mistakes);
  });

  it('penalises a concept asked moments ago', () => {
    const justAsked = scoreConcept(candidate({ conceptId: 'a', lastAskedAt: minsAgo(1) }), T0);
    const askedYesterday = scoreConcept(candidate({ conceptId: 'a', lastAskedAt: daysAgo(1) }), T0);
    expect(justAsked.score).toBeLessThan(askedYesterday.score);
    expect(justAsked.signals.repetition).toBeGreaterThan(0.9);
  });

  it('lets the repetition penalty decay', () => {
    const now = scoreConcept(candidate({ conceptId: 'a', lastAskedAt: minsAgo(0) }), T0);
    const later = scoreConcept(candidate({ conceptId: 'a', lastAskedAt: minsAgo(20) }), T0);
    const gone = scoreConcept(candidate({ conceptId: 'a', lastAskedAt: minsAgo(45) }), T0);
    expect(later.signals.repetition).toBeLessThan(now.signals.repetition);
    expect(gone.signals.repetition).toBe(0);
  });

  it('applies no repetition penalty to a concept never asked', () => {
    expect(scoreConcept(candidate({ conceptId: 'a', lastAskedAt: null }), T0).signals.repetition).toBe(0);
  });
});

describe('selectNextQuestion', () => {
  it('returns null when there is nothing to ask about', () => {
    expect(selectNextQuestion([], T0)).toBeNull();
  });

  it('picks the weakest concept and explains why', () => {
    const selection = selectNextQuestion(
      [
        candidate({ conceptId: 'secure', mastery: mastery(0.9, 10) }),
        candidate({ conceptId: 'shaky', mastery: mastery(0.25, 10) }),
        candidate({ conceptId: 'ok', mastery: mastery(0.6, 10) }),
      ],
      T0,
    );
    expect(selection!.conceptId).toBe('shaky');
    // Adaptivity has to be explainable, not magic.
    expect(selection!.reason.signals.need).toBeGreaterThan(0.7);
    expect(selection!.alternatives.length).toBeGreaterThan(0);
  });

  it('does not ask the same concept twice in a row when alternatives exist', () => {
    // The most common way a naive selector feels broken.
    const selection = selectNextQuestion(
      [
        candidate({ conceptId: 'just-asked', mastery: mastery(0.3, 10), lastAskedAt: minsAgo(1) }),
        candidate({ conceptId: 'other', mastery: mastery(0.45, 10), lastAskedAt: daysAgo(2) }),
      ],
      T0,
    );
    expect(selection!.conceptId).toBe('other');
  });

  it('returns to a weak concept once the repetition penalty has decayed', () => {
    const later = new Date(T0.getTime() + 60 * 60_000);
    const selection = selectNextQuestion(
      [
        candidate({ conceptId: 'weak', mastery: mastery(0.2, 10), lastAskedAt: T0 }),
        candidate({ conceptId: 'fine', mastery: mastery(0.7, 10), lastAskedAt: daysAgo(3) }),
      ],
      later,
    );
    expect(selection!.conceptId).toBe('weak');
  });

  it('is deterministic, including ties', () => {
    // Same inputs must always give the same question, or adaptivity cannot be
    // tested or explained.
    const candidates = [
      candidate({ conceptId: 'b-concept', mastery: mastery(0.5, 5) }),
      candidate({ conceptId: 'a-concept', mastery: mastery(0.5, 5) }),
    ];
    const first = selectNextQuestion(candidates, T0);
    const second = selectNextQuestion([...candidates].reverse(), T0);
    expect(first!.conceptId).toBe(second!.conceptId);
    expect(first!.conceptId).toBe('a-concept');
  });

  it('balances need against coverage rather than obsessing over one concept', () => {
    // Twelve selections across a mixed project should touch several concepts.
    const concepts = ['a', 'b', 'c', 'd'].map((id, i) =>
      candidate({ conceptId: id, mastery: mastery(0.3 + i * 0.15, 6) }),
    );
    const chosen = new Set<string>();
    let clock = T0;
    const lastAsked = new Map<string, Date>();

    for (let i = 0; i < 12; i++) {
      const pool = concepts.map((c) => ({ ...c, lastAskedAt: lastAsked.get(c.conceptId) ?? null }));
      const s = selectNextQuestion(pool, clock)!;
      chosen.add(s.conceptId);
      lastAsked.set(s.conceptId, clock);
      clock = new Date(clock.getTime() + 3 * 60_000);
    }
    expect(chosen.size).toBeGreaterThanOrEqual(3);
  });

  it('pairs the chosen concept with a difficulty derived from ITS mastery', () => {
    const selection = selectNextQuestion(
      [candidate({ conceptId: 'weak', mastery: mastery(0.15, 10) })],
      T0,
    );
    expect(selection!.difficulty).toBeLessThanOrEqual(2);
  });

  it('does not let recent mistakes outrank a genuinely weaker concept', () => {
    // Mistakes already lowered mastery, so they are present in `need` too.
    // Weighting them as a co-equal signal double-counts the same evidence and
    // sends the learner to the wrong concept (D-039).
    const pool = [
      candidate({ conceptId: 'weak', mastery: mastery(0.2, 10), recentMistakes: 0 }),
      candidate({ conceptId: 'missed', mastery: mastery(0.65, 10), recentMistakes: 3 }),
    ];
    expect(selectNextQuestion(pool, T0, DEFAULT_WEIGHTS)!.conceptId).toBe('weak');
  });

  it('lets mistakes break a tie between equally weak concepts', () => {
    // Their real job: mastery lags the most recent answers.
    const pool = [
      candidate({ conceptId: 'a-calm', mastery: mastery(0.4, 10), recentMistakes: 0 }),
      candidate({ conceptId: 'b-struggling', mastery: mastery(0.4, 10), recentMistakes: 3 }),
    ];
    expect(selectNextQuestion(pool, T0, DEFAULT_WEIGHTS)!.conceptId).toBe('b-struggling');
  });

  it('respects custom weights', () => {
    const pool = [
      candidate({ conceptId: 'weak', mastery: mastery(0.2, 10), recentMistakes: 0 }),
      candidate({ conceptId: 'missed', mastery: mastery(0.65, 10), recentMistakes: 3 }),
    ];
    expect(
      selectNextQuestion(pool, T0, { ...DEFAULT_WEIGHTS, mistakes: 5 })!.conceptId,
    ).toBe('missed');
  });
});
