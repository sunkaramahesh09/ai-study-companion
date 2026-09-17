import { describe, expect, it } from 'vitest';
import {
  bucketByDay,
  groundingRate,
  studyStreak,
  summariseAiUsage,
  summariseAssessment,
  type AiRequestRow,
  type AnswerRow,
  type EventRow,
} from './activity.ts';

const NOW = new Date('2026-09-17T15:00:00Z');
const daysAgo = (n: number, hour = 10) =>
  new Date(Date.UTC(2026, 8, 17 - n, hour, 0, 0));

const ev = (type: string, n: number): EventRow => ({ type, at: daysAgo(n) });

describe('bucketByDay', () => {
  it('zero-fills days with no activity', () => {
    // A chart drawn only from days that have events closes the gaps, so two
    // sessions a fortnight apart render as consistency.
    const buckets = bucketByDay([ev('quiz_completed', 0), ev('quiz_completed', 4)], { days: 7, now: NOW });
    expect(buckets).toHaveLength(7);
    expect(buckets.map((b) => b.total)).toEqual([0, 0, 1, 0, 0, 0, 1]);
  });

  it('runs oldest to newest and ends on today', () => {
    const buckets = bucketByDay([], { days: 3, now: NOW });
    expect(buckets.map((b) => b.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17']);
  });

  it('splits counts by event type', () => {
    const buckets = bucketByDay(
      [ev('tutor_question', 1), ev('tutor_question', 1), ev('quiz_completed', 1)],
      { days: 3, now: NOW },
    );
    expect(buckets[1]!.byType).toEqual({ tutor_question: 2, quiz_completed: 1 });
  });

  it('ignores events outside the window in both directions', () => {
    const future = { type: 'quiz_completed', at: new Date('2026-09-20T10:00:00Z') };
    const buckets = bucketByDay([ev('quiz_completed', 40), future], { days: 7, now: NOW });
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(0);
  });

  it('keeps an event late on the current day', () => {
    const late = { type: 'quiz_completed', at: new Date('2026-09-17T23:59:00Z') };
    const buckets = bucketByDay([late], { days: 2, now: NOW });
    expect(buckets.at(-1)!.total).toBe(1);
  });
});

describe('studyStreak', () => {
  it('counts consecutive days back from today', () => {
    const buckets = bucketByDay([ev('x', 0), ev('x', 1), ev('x', 2), ev('x', 5)], { days: 7, now: NOW });
    const streak = studyStreak(buckets);
    expect(streak.current).toBe(3);
    expect(streak.activeDays).toBe(4);
  });

  it('does not break the streak just because today is still empty', () => {
    // Otherwise the number a learner sees every morning is zero, which
    // punishes them for checking early.
    const buckets = bucketByDay([ev('x', 1), ev('x', 2)], { days: 7, now: NOW });
    expect(studyStreak(buckets).current).toBe(2);
  });

  it('breaks on a gap before yesterday', () => {
    const buckets = bucketByDay([ev('x', 2), ev('x', 3)], { days: 7, now: NOW });
    expect(studyStreak(buckets).current).toBe(0);
  });

  it('reports the longest run in the window', () => {
    const buckets = bucketByDay([ev('x', 6), ev('x', 5), ev('x', 4), ev('x', 3), ev('x', 0)], { days: 7, now: NOW });
    const streak = studyStreak(buckets);
    expect(streak.longest).toBe(4);
    expect(streak.current).toBe(1);
  });

  it('handles an empty window', () => {
    expect(studyStreak(bucketByDay([], { days: 7, now: NOW }))).toEqual({
      current: 0, longest: 0, activeDays: 0,
    });
  });
});

const answer = (over: Partial<AnswerRow>): AnswerRow => ({
  isCorrect: true,
  difficulty: 3,
  questionType: 'mcq',
  score: 1,
  answeredAt: daysAgo(1),
  ...over,
});

describe('summariseAssessment', () => {
  it('ignores unanswered questions', () => {
    // Closing the tab mid-quiz must not damage the learner's statistics.
    const rows = [
      answer({ isCorrect: true }),
      answer({ isCorrect: false }),
      answer({ isCorrect: null, answeredAt: null, score: null }),
    ];
    const s = summariseAssessment(rows);
    expect(s.answered).toBe(2);
    expect(s.accuracy).toBe(0.5);
  });

  it('breaks accuracy down by question type', () => {
    const rows = [
      answer({ questionType: 'mcq', isCorrect: true }),
      answer({ questionType: 'mcq', isCorrect: true }),
      answer({ questionType: 'open', isCorrect: false }),
    ];
    const s = summariseAssessment(rows);
    expect(s.byType.mcq.accuracy).toBe(1);
    expect(s.byType.open.accuracy).toBe(0);
  });

  it('breaks accuracy down by difficulty, ascending', () => {
    const rows = [
      answer({ difficulty: 4, isCorrect: false }),
      answer({ difficulty: 1, isCorrect: true }),
      answer({ difficulty: 1, isCorrect: true }),
    ];
    const s = summariseAssessment(rows);
    expect(s.byDifficulty.map((d) => d.difficulty)).toEqual([1, 4]);
    expect(s.byDifficulty[0]!.accuracy).toBe(1);
    expect(s.byDifficulty[1]!.accuracy).toBe(0);
  });

  it('averages difficulty over attempted questions only', () => {
    const rows = [
      answer({ difficulty: 2 }),
      answer({ difficulty: 4 }),
      answer({ difficulty: 5, isCorrect: null, answeredAt: null }),
    ];
    expect(summariseAssessment(rows).averageDifficulty).toBe(3);
  });

  it('refuses to compare recent against prior without enough of both', () => {
    // Two answers against one is noise presented as a trend.
    const rows = Array.from({ length: 8 }, () => answer({}));
    const s = summariseAssessment(rows);
    expect(s.recentAccuracy).toBeNull();
    expect(s.priorAccuracy).toBeNull();
  });

  it('compares recent against prior once there is enough history', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => answer({ isCorrect: false, answeredAt: daysAgo(10 - i) })),
      ...Array.from({ length: 10 }, (_, i) => answer({ isCorrect: true, answeredAt: daysAgo(4 - i * 0.1) })),
    ];
    const s = summariseAssessment(rows);
    expect(s.priorAccuracy).toBe(0);
    expect(s.recentAccuracy).toBe(1);
  });

  it('orders by answer time, not by input order', () => {
    const rows = [
      answer({ isCorrect: true, answeredAt: daysAgo(0) }),
      ...Array.from({ length: 12 }, (_, i) => answer({ isCorrect: false, answeredAt: daysAgo(12 - i) })),
    ];
    const s = summariseAssessment(rows);
    // The one correct answer is the most recent, so it lands in the recent window.
    expect(s.recentAccuracy).toBeGreaterThan(0);
  });

  it('reports nulls rather than zeros for an untouched project', () => {
    const s = summariseAssessment([]);
    expect(s.accuracy).toBeNull();
    expect(s.averageDifficulty).toBeNull();
    expect(s.byDifficulty).toEqual([]);
  });
});

const req = (over: Partial<AiRequestRow>): AiRequestRow => ({
  feature: 'tutor_answer',
  model: 'openai/gpt-oss-120b',
  status: 'success',
  latencyMs: 1000,
  totalTokens: 900,
  estimatedCostUsd: 0.0001,
  usedFallback: false,
  ...over,
});

describe('summariseAiUsage', () => {
  it('measures latency over successes only', () => {
    // A request that 429'd after four backoff waits is slow in a way that says
    // nothing about how long the model takes to answer.
    const rows = [
      req({ latencyMs: 100 }),
      req({ latencyMs: 200 }),
      req({ status: 'rate_limited', latencyMs: 90_000 }),
    ];
    const s = summariseAiUsage(rows);
    expect(s.medianLatencyMs).toBe(100);
    expect(s.p95LatencyMs).toBe(200);
    expect(s.failures).toBe(1);
  });

  it('totals tokens and cost across every request, failed ones included', () => {
    // A failed call still spent the prompt.
    const rows = [req({ totalTokens: 100, estimatedCostUsd: 0.01 }), req({ status: 'error', totalTokens: 50, estimatedCostUsd: 0.005 })];
    const s = summariseAiUsage(rows);
    expect(s.totalTokens).toBe(150);
    expect(s.estimatedCostUsd).toBeCloseTo(0.015, 8);
    expect(s.successRate).toBe(0.5);
  });

  it('groups by feature, heaviest first', () => {
    const rows = [
      req({ feature: 'embedding', totalTokens: 50 }),
      req({ feature: 'tutor_answer', totalTokens: 2000 }),
      req({ feature: 'tutor_answer', totalTokens: 1000 }),
    ];
    const s = summariseAiUsage(rows);
    expect(s.byFeature[0]!.feature).toBe('tutor_answer');
    expect(s.byFeature[0]!.totalTokens).toBe(3000);
    expect(s.byFeature[0]!.requests).toBe(2);
  });

  it('reports the fallback rate', () => {
    const rows = [req({ usedFallback: true }), req({}), req({}), req({})];
    expect(summariseAiUsage(rows).fallbackRate).toBe(0.25);
  });

  it('tolerates missing token and cost figures', () => {
    const rows = [req({ totalTokens: null, estimatedCostUsd: null, latencyMs: null })];
    const s = summariseAiUsage(rows);
    expect(s.totalTokens).toBe(0);
    expect(s.estimatedCostUsd).toBe(0);
    expect(s.medianLatencyMs).toBeNull();
  });

  it('handles no requests at all', () => {
    const s = summariseAiUsage([]);
    expect(s.requests).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.byFeature).toEqual([]);
  });

  it('is stable regardless of row order', () => {
    const rows = [req({ feature: 'a', totalTokens: 10 }), req({ feature: 'b', totalTokens: 10 })];
    expect(summariseAiUsage(rows).byFeature).toEqual(summariseAiUsage([...rows].reverse()).byFeature);
  });
});

describe('groundingRate', () => {
  it('reports answers against refusals', () => {
    const events = [ev('tutor_answer', 1), ev('tutor_answer', 1), ev('tutor_unsupported', 1), ev('quiz_started', 1)];
    expect(groundingRate(events)).toEqual({ answered: 2, refused: 1, rate: 0.6667 });
  });

  it('reports null rather than 0 when the Tutor has not been used', () => {
    expect(groundingRate([ev('quiz_started', 1)]).rate).toBeNull();
  });
});
