import { describe, expect, it } from 'vitest';
import { detectRepeatedMistakes, type AnswerRecord } from './mistakes.ts';

const T0 = new Date('2026-09-17T10:00:00Z');
const daysAgo = (n: number) => new Date(T0.getTime() - n * 86_400_000);

const rec = (
  conceptId: string | null,
  isCorrect: boolean,
  over: Partial<AnswerRecord> = {},
): AnswerRecord => ({
  conceptId,
  conceptName: conceptId ?? 'unknown',
  isCorrect,
  difficulty: 3,
  answeredAt: daysAgo(1),
  ...over,
});

describe('detectRepeatedMistakes', () => {
  it('ignores a single wrong answer', () => {
    // A slip is not a pattern. Treating it as one would fire a recommendation
    // after every normal quiz.
    const patterns = detectRepeatedMistakes([rec('a', false), rec('a', true)], T0);
    expect(patterns).toEqual([]);
  });

  it('detects two or more mistakes on the same concept', () => {
    const patterns = detectRepeatedMistakes(
      [rec('a', false, { answeredAt: daysAgo(2) }), rec('a', false, { answeredAt: daysAgo(1) })],
      T0,
    );
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ conceptId: 'a', mistakes: 2, attempts: 2, errorRate: 1 });
  });

  it('marks a pattern recovered once the learner gets it right afterwards', () => {
    // Otherwise the system keeps nagging about something already fixed.
    const patterns = detectRepeatedMistakes(
      [
        rec('a', false, { answeredAt: daysAgo(4) }),
        rec('a', false, { answeredAt: daysAgo(3) }),
        rec('a', true, { answeredAt: daysAgo(1) }),
      ],
      T0,
    );
    expect(patterns[0]!.recovered).toBe(true);
    expect(patterns[0]!.severity).toBe('watch');
  });

  it('does not count a correct answer BEFORE the last mistake as recovery', () => {
    const patterns = detectRepeatedMistakes(
      [
        rec('a', false, { answeredAt: daysAgo(5) }),
        rec('a', true, { answeredAt: daysAgo(4) }),
        rec('a', false, { answeredAt: daysAgo(1) }),
      ],
      T0,
    );
    expect(patterns[0]!.recovered).toBe(false);
  });

  it('ignores answers outside the window', () => {
    const patterns = detectRepeatedMistakes(
      [rec('a', false, { answeredAt: daysAgo(40) }), rec('a', false, { answeredAt: daysAgo(35) })],
      T0,
    );
    expect(patterns).toEqual([]);
  });

  it('ignores answers with no concept attached', () => {
    expect(detectRepeatedMistakes([rec(null, false), rec(null, false)], T0)).toEqual([]);
  });

  it('treats repeated EASY mistakes as more serious than hard ones', () => {
    // Missing hard questions is expected; missing easy ones is a real gap.
    const easy = detectRepeatedMistakes(
      [
        rec('easy', false, { difficulty: 1, answeredAt: daysAgo(3) }),
        rec('easy', false, { difficulty: 2, answeredAt: daysAgo(1) }),
      ],
      T0,
    );
    const hard = detectRepeatedMistakes(
      [
        rec('hard', false, { difficulty: 5, answeredAt: daysAgo(3) }),
        rec('hard', false, { difficulty: 5, answeredAt: daysAgo(1) }),
        rec('hard', true, { answeredAt: daysAgo(2) }),
      ],
      T0,
    );
    expect(easy[0]!.severity).toBe('blocked');
    expect(hard[0]!.severity).not.toBe('blocked');
  });

  it('ranks worse patterns first', () => {
    const patterns = detectRepeatedMistakes(
      [
        rec('mild', false, { answeredAt: daysAgo(5) }),
        rec('mild', false, { answeredAt: daysAgo(4) }),
        rec('mild', true, { answeredAt: daysAgo(3) }),
        rec('mild', true, { answeredAt: daysAgo(2) }),
        rec('severe', false, { difficulty: 1, answeredAt: daysAgo(3) }),
        rec('severe', false, { difficulty: 1, answeredAt: daysAgo(2) }),
        rec('severe', false, { difficulty: 2, answeredAt: daysAgo(1) }),
      ],
      T0,
    );
    expect(patterns[0]!.conceptId).toBe('severe');
    expect(patterns[0]!.severity).toBe('blocked');
  });

  it('separates patterns per concept', () => {
    const patterns = detectRepeatedMistakes(
      [
        rec('a', false, { answeredAt: daysAgo(3) }),
        rec('a', false, { answeredAt: daysAgo(2) }),
        rec('b', false, { answeredAt: daysAgo(3) }),
        rec('b', false, { answeredAt: daysAgo(2) }),
      ],
      T0,
    );
    expect(patterns.map((p) => p.conceptId).sort()).toEqual(['a', 'b']);
  });

  it('reports an error rate reflecting attempts, not just mistakes', () => {
    const patterns = detectRepeatedMistakes(
      [
        rec('a', false, { answeredAt: daysAgo(5) }),
        rec('a', false, { answeredAt: daysAgo(4) }),
        rec('a', true, { answeredAt: daysAgo(3) }),
        rec('a', true, { answeredAt: daysAgo(2) }),
      ],
      T0,
    );
    expect(patterns[0]!.errorRate).toBe(0.5);
  });

  it('is deterministic for the same evidence', () => {
    const answers = [
      rec('a', false, { answeredAt: daysAgo(3) }),
      rec('a', false, { answeredAt: daysAgo(2) }),
      rec('b', false, { answeredAt: daysAgo(3) }),
      rec('b', false, { answeredAt: daysAgo(2) }),
    ];
    expect(detectRepeatedMistakes(answers, T0)).toEqual(
      detectRepeatedMistakes([...answers].reverse(), T0),
    );
  });

  it('respects a custom threshold', () => {
    const answers = [
      rec('a', false, { answeredAt: daysAgo(3) }),
      rec('a', false, { answeredAt: daysAgo(2) }),
    ];
    expect(detectRepeatedMistakes(answers, T0, { minMistakes: 3 })).toEqual([]);
  });
});
