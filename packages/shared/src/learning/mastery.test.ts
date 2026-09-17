import { describe, expect, it } from 'vitest';
import {
  PRIOR_MASTERY,
  effectiveEvidence,
  expectedSuccess,
  masteryBand,
  masteryConfidence,
  normaliseDifficulty,
  replayMastery,
  updateMastery,
  type AnswerEvidence,
  type MasteryState,
} from './mastery.ts';

const T0 = new Date('2026-09-17T10:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const fresh = (over: Partial<MasteryState> = {}): MasteryState => ({
  score: PRIOR_MASTERY,
  evidenceCount: 0,
  lastEvidenceAt: null,
  ...over,
});

const answer = (correctness: number, difficulty: number, at: Date = T0): AnswerEvidence => ({
  correctness,
  difficulty,
  answeredAt: at,
});

describe('normaliseDifficulty', () => {
  it('maps the 1..5 scale onto 0..1', () => {
    expect(normaliseDifficulty(1)).toBe(0);
    expect(normaliseDifficulty(3)).toBe(0.5);
    expect(normaliseDifficulty(5)).toBe(1);
  });

  it('clamps out-of-range input rather than producing nonsense', () => {
    expect(normaliseDifficulty(0)).toBe(0);
    expect(normaliseDifficulty(99)).toBe(1);
  });
});

describe('expectedSuccess', () => {
  it('is even money when ability matches difficulty', () => {
    expect(expectedSuccess(0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('rises as ability exceeds difficulty', () => {
    expect(expectedSuccess(0.9, 0.2)).toBeGreaterThan(0.95);
    expect(expectedSuccess(0.2, 0.9)).toBeLessThan(0.05);
  });

  it('is monotonic in ability', () => {
    const at = (m: number) => expectedSuccess(m, 0.5);
    expect(at(0.3)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(0.7));
  });
});

describe('updateMastery — the core property', () => {
  it('moves by the SURPRISE, not by the outcome', () => {
    // This is the whole model, and the thing that makes it more than
    // "wrong -> easy, correct -> hard" (PRD §9).
    const strong = fresh({ score: 0.9, evidenceCount: 5, lastEvidenceAt: T0 });

    // Expected to succeed and did: barely moves.
    const unsurprising = updateMastery(strong, answer(1, 1), T0);
    // Expected to succeed and failed: moves a lot, downward.
    const surprising = updateMastery(strong, answer(0, 1), T0);

    expect(Math.abs(unsurprising.delta)).toBeLessThan(0.02);
    expect(surprising.delta).toBeLessThan(-0.1);
    expect(Math.abs(surprising.delta)).toBeGreaterThan(Math.abs(unsurprising.delta) * 5);
  });

  it('rewards a hard question more than an easy one', () => {
    const state = fresh();
    const easy = updateMastery(state, answer(1, 1), T0);
    const hard = updateMastery(state, answer(1, 5), T0);
    expect(hard.delta).toBeGreaterThan(easy.delta);
  });

  it('punishes an easy mistake more than a hard one', () => {
    const state = fresh();
    const easy = updateMastery(state, answer(0, 1), T0);
    const hard = updateMastery(state, answer(0, 5), T0);
    expect(easy.delta).toBeLessThan(hard.delta);
  });

  it('accepts partial credit from open-ended grading', () => {
    const state = fresh();
    const partial = updateMastery(state, answer(0.5, 3), T0);
    const full = updateMastery(state, answer(1, 3), T0);
    const none = updateMastery(state, answer(0, 3), T0);
    expect(partial.score).toBeGreaterThan(none.score);
    expect(partial.score).toBeLessThan(full.score);
  });

  it('settles as evidence accumulates', () => {
    // Otherwise the estimate would oscillate forever on every answer.
    const early = updateMastery(fresh({ evidenceCount: 0, lastEvidenceAt: T0 }), answer(1, 3), T0);
    const late = updateMastery(fresh({ evidenceCount: 20, lastEvidenceAt: T0 }), answer(1, 3), T0);
    expect(Math.abs(late.delta)).toBeLessThan(Math.abs(early.delta));
  });

  it('never leaves the 0..1 range', () => {
    let state = fresh({ score: 0.02, evidenceCount: 1, lastEvidenceAt: T0 });
    for (let i = 0; i < 40; i++) {
      const u = updateMastery(state, answer(0, 1), T0);
      state = { score: u.score, evidenceCount: u.evidenceCount, lastEvidenceAt: T0 };
    }
    expect(state.score).toBeGreaterThanOrEqual(0);

    state = fresh({ score: 0.98, evidenceCount: 1, lastEvidenceAt: T0 });
    for (let i = 0; i < 40; i++) {
      const u = updateMastery(state, answer(1, 5), T0);
      state = { score: u.score, evidenceCount: u.evidenceCount, lastEvidenceAt: T0 };
    }
    expect(state.score).toBeLessThanOrEqual(1);
  });

  it('is deterministic — identical input, identical output', () => {
    // The point of not using an LLM for this.
    const a = updateMastery(fresh(), answer(1, 4), T0);
    const b = updateMastery(fresh(), answer(1, 4), T0);
    expect(a).toEqual(b);
  });

  it('counts evidence even when the score does not move', () => {
    const state = fresh({ score: 0.5, evidenceCount: 3, lastEvidenceAt: T0 });
    const u = updateMastery(state, answer(1, 3), T0);
    expect(u.evidenceCount).toBe(4);
  });
});

describe('staleness', () => {
  it('discounts old evidence without touching the score', () => {
    // Drifting mastery down while the learner is away would invent evidence of
    // forgetting we never observed (D-038).
    const state = fresh({ score: 0.8, evidenceCount: 10, lastEvidenceAt: T0 });
    expect(effectiveEvidence(state, T0)).toBe(10);
    expect(effectiveEvidence(state, days(21))).toBeCloseTo(5, 1);
    expect(effectiveEvidence(state, days(42))).toBeCloseTo(2.5, 1);
    // The stored score itself is untouched.
    expect(state.score).toBe(0.8);
  });

  it('makes the system more willing to update after a long gap', () => {
    const state = fresh({ score: 0.8, evidenceCount: 10, lastEvidenceAt: T0 });
    const soon = updateMastery(state, answer(0, 3), T0);
    const later = updateMastery(state, answer(0, 3), days(60));
    expect(Math.abs(later.delta)).toBeGreaterThan(Math.abs(soon.delta));
  });

  it('reports no effective evidence when there is none', () => {
    expect(effectiveEvidence(fresh(), T0)).toBe(0);
  });
});

describe('confidence and bands', () => {
  it('starts unassessed and honest about it', () => {
    // 0.5 is "we do not know", not "half mastered".
    const state = fresh();
    expect(state.score).toBe(0.5);
    expect(masteryBand(state, T0)).toBe('unassessed');
    expect(masteryConfidence(state, T0)).toBe(0);
  });

  it('grows confidence with evidence', () => {
    const one = masteryConfidence(fresh({ evidenceCount: 1, lastEvidenceAt: T0 }), T0);
    const many = masteryConfidence(fresh({ evidenceCount: 15, lastEvidenceAt: T0 }), T0);
    expect(many).toBeGreaterThan(one);
    expect(many).toBeLessThan(1);
  });

  it('refuses to call a concept secure on a single answer', () => {
    // A lucky guess must not read as mastery.
    const state = fresh({ score: 0.95, evidenceCount: 1, lastEvidenceAt: T0 });
    expect(masteryBand(state, T0)).not.toBe('secure');
  });

  it('calls a well-evidenced high score secure', () => {
    expect(masteryBand(fresh({ score: 0.85, evidenceCount: 12, lastEvidenceAt: T0 }), T0)).toBe('secure');
  });

  it('calls a well-evidenced low score needs_work', () => {
    expect(masteryBand(fresh({ score: 0.3, evidenceCount: 8, lastEvidenceAt: T0 }), T0)).toBe('needs_work');
  });
});

describe('replayMastery — realistic trajectories', () => {
  it('converges upward for a consistently correct learner', () => {
    const evidence = Array.from({ length: 10 }, (_, i) => answer(1, 3, days(i)));
    const state = replayMastery(evidence);
    expect(state.score).toBeGreaterThan(0.75);
    expect(state.evidenceCount).toBe(10);
  });

  it('converges downward for a consistently wrong learner', () => {
    const evidence = Array.from({ length: 10 }, (_, i) => answer(0, 3, days(i)));
    expect(replayMastery(evidence).score).toBeLessThan(0.25);
  });

  it('lands mid-range for an inconsistent learner', () => {
    const evidence = Array.from({ length: 12 }, (_, i) => answer(i % 2 === 0 ? 1 : 0, 3, days(i)));
    const score = replayMastery(evidence).score;
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.7);
  });

  it('does not let one bad answer undo a strong record', () => {
    // The difference between an estimate and a scoreboard.
    const good = Array.from({ length: 12 }, (_, i) => answer(1, 3, days(i)));
    const strong = replayMastery(good);
    const afterSlip = replayMastery([answer(0, 3, days(12))], strong);
    expect(afterSlip.score).toBeGreaterThan(0.6);
  });
});
