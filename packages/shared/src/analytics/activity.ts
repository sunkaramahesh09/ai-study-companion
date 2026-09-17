/**
 * Analytics aggregation. Deterministic — no AI, no I/O.
 *
 * The PRD (§12) asks Project Analytics to show learning activity, assessment
 * performance, mastery, concept trends and AI activity, and Global Analytics
 * to aggregate the same across Projects and Spaces. All of it is arithmetic
 * over `learning_events`, `quiz_questions` and `ai_requests`, so all of it
 * lives here as pure functions rather than in a route where it cannot be
 * tested without a database.
 */

export type EventRow = {
  type: string;
  at: Date;
};

export type DayBucket = {
  /** `YYYY-MM-DD` in UTC. */
  date: string;
  total: number;
  /** Per-event-type counts, so a sparkline can be split by activity. */
  byType: Record<string, number>;
};

/**
 * Activity per day across a fixed window, including days with nothing.
 *
 * Zero-filling matters: a chart drawn only from days that have events silently
 * closes the gaps, so a learner who studied twice a fortnight apart sees two
 * adjacent bars and reads it as consistency.
 */
export function bucketByDay(events: EventRow[], opts: { days: number; now?: Date }): DayBucket[] {
  const now = opts.now ?? new Date();
  const today = startOfUtcDay(now);
  const buckets = new Map<string, DayBucket>();

  for (let i = opts.days - 1; i >= 0; i--) {
    const date = isoDate(new Date(today.getTime() - i * 86_400_000));
    buckets.set(date, { date, total: 0, byType: {} });
  }

  const earliest = new Date(today.getTime() - (opts.days - 1) * 86_400_000);
  for (const e of events) {
    if (e.at < earliest || e.at >= new Date(today.getTime() + 86_400_000)) continue;
    const bucket = buckets.get(isoDate(e.at));
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byType[e.type] = (bucket.byType[e.type] ?? 0) + 1;
  }

  return [...buckets.values()];
}

export type StudyStreak = {
  /** Consecutive days with activity, counting back from today. */
  current: number;
  longest: number;
  /** Distinct days with any activity in the window. */
  activeDays: number;
};

/**
 * Streaks over the same window.
 *
 * A streak is counted from today backwards, but today having no activity yet
 * does not break it — otherwise the number a learner sees every morning is
 * zero, which punishes them for checking early. Yesterday is the first day
 * that can break a streak.
 */
export function studyStreak(buckets: DayBucket[]): StudyStreak {
  const activeDays = buckets.filter((b) => b.total > 0).length;

  let longest = 0;
  let run = 0;
  for (const b of buckets) {
    run = b.total > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  let current = 0;
  for (let i = buckets.length - 1; i >= 0; i--) {
    const isToday = i === buckets.length - 1;
    if (buckets[i]!.total > 0) current += 1;
    else if (isToday) continue;
    else break;
  }

  return { current, longest, activeDays };
}

export type AnswerRow = {
  isCorrect: boolean | null;
  difficulty: number;
  questionType: 'mcq' | 'open';
  score: number | null;
  answeredAt: Date | null;
};

export type AssessmentSummary = {
  answered: number;
  correct: number;
  /** 0..1, or null when nothing has been answered. */
  accuracy: number | null;
  /** Mean difficulty of what was actually attempted. */
  averageDifficulty: number | null;
  byType: Record<'mcq' | 'open', { answered: number; correct: number; accuracy: number | null }>;
  byDifficulty: { difficulty: number; answered: number; correct: number; accuracy: number | null }[];
  /**
   * Accuracy over the most recent answers versus everything before them.
   * Null when there is not enough on one side to compare honestly.
   */
  recentAccuracy: number | null;
  priorAccuracy: number | null;
};

/** How many recent answers form the "lately" half of the comparison. */
const RECENT_WINDOW = 10;

export function summariseAssessment(rows: AnswerRow[]): AssessmentSummary {
  // Unanswered questions belong to an abandoned or in-flight attempt. Counting
  // them as wrong would let closing the tab damage a learner's statistics.
  const answered = rows
    .filter((r) => r.answeredAt !== null && r.isCorrect !== null)
    .sort((a, b) => a.answeredAt!.getTime() - b.answeredAt!.getTime());

  const correct = answered.filter((r) => r.isCorrect).length;

  const byType = {
    mcq: typeSlice(answered, 'mcq'),
    open: typeSlice(answered, 'open'),
  };

  const difficulties = [...new Set(answered.map((r) => r.difficulty))].sort((a, b) => a - b);
  const byDifficulty = difficulties.map((difficulty) => {
    const slice = answered.filter((r) => r.difficulty === difficulty);
    const hit = slice.filter((r) => r.isCorrect).length;
    return { difficulty, answered: slice.length, correct: hit, accuracy: ratio(hit, slice.length) };
  });

  // Only compare when both sides have enough answers to mean anything. Two
  // answers against one is noise presented as a trend.
  let recentAccuracy: number | null = null;
  let priorAccuracy: number | null = null;
  if (answered.length >= RECENT_WINDOW + 3) {
    const recent = answered.slice(-RECENT_WINDOW);
    const prior = answered.slice(0, -RECENT_WINDOW);
    recentAccuracy = ratio(recent.filter((r) => r.isCorrect).length, recent.length);
    priorAccuracy = ratio(prior.filter((r) => r.isCorrect).length, prior.length);
  }

  return {
    answered: answered.length,
    correct,
    accuracy: ratio(correct, answered.length),
    averageDifficulty:
      answered.length > 0
        ? round4(answered.reduce((s, r) => s + r.difficulty, 0) / answered.length)
        : null,
    byType,
    byDifficulty,
    recentAccuracy,
    priorAccuracy,
  };
}

export type AiRequestRow = {
  feature: string;
  model: string;
  status: string;
  latencyMs: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  usedFallback: boolean;
};

export type AiUsageSummary = {
  requests: number;
  successes: number;
  failures: number;
  successRate: number | null;
  totalTokens: number;
  estimatedCostUsd: number;
  /** p50 and p95 over successful requests only. */
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  fallbackRate: number | null;
  byFeature: { feature: string; requests: number; totalTokens: number; estimatedCostUsd: number }[];
  byModel: { model: string; requests: number; totalTokens: number }[];
};

export function summariseAiUsage(rows: AiRequestRow[]): AiUsageSummary {
  const successes = rows.filter((r) => r.status === 'success');

  // Latency is measured over successes only. A request that 429'd after four
  // backoff waits is slow in a way that says nothing about how long the model
  // takes to answer, and mixing the two makes both numbers unreadable.
  const latencies = successes
    .map((r) => r.latencyMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);

  const byFeature = groupBy(rows, (r) => r.feature).map(([feature, group]) => ({
    feature,
    requests: group.length,
    totalTokens: sum(group.map((r) => r.totalTokens ?? 0)),
    estimatedCostUsd: round8(sum(group.map((r) => r.estimatedCostUsd ?? 0))),
  }));

  const byModel = groupBy(rows, (r) => r.model).map(([model, group]) => ({
    model,
    requests: group.length,
    totalTokens: sum(group.map((r) => r.totalTokens ?? 0)),
  }));

  return {
    requests: rows.length,
    successes: successes.length,
    failures: rows.length - successes.length,
    successRate: ratio(successes.length, rows.length),
    totalTokens: sum(rows.map((r) => r.totalTokens ?? 0)),
    estimatedCostUsd: round8(sum(rows.map((r) => r.estimatedCostUsd ?? 0))),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    fallbackRate: ratio(rows.filter((r) => r.usedFallback).length, rows.length),
    byFeature: byFeature.sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: byModel.sort((a, b) => b.requests - a.requests),
  };
}

/**
 * How often the Tutor declined for lack of evidence.
 *
 * Reported as a headline number on purpose. A refusal is correct behaviour
 * (PRD §7), so this is a quality signal, not an error rate — but a rate near
 * zero usually means the evidence gate is too loose, and a rate near one means
 * the material does not cover what the learner is asking.
 */
export function groundingRate(events: EventRow[]): { answered: number; refused: number; rate: number | null } {
  const answered = events.filter((e) => e.type === 'tutor_answer').length;
  const refused = events.filter((e) => e.type === 'tutor_unsupported').length;
  return { answered, refused, rate: ratio(answered, answered + refused) };
}

// --- helpers ---------------------------------------------------------------

function typeSlice(rows: AnswerRow[], type: 'mcq' | 'open') {
  const slice = rows.filter((r) => r.questionType === type);
  const correct = slice.filter((r) => r.isCorrect).length;
  return { answered: slice.length, correct, accuracy: ratio(correct, slice.length) };
}

function groupBy<T>(rows: T[], key: (row: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  // Sorted so the output is stable regardless of row order.
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? round4(part / whole) : null;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round8(n: number): number {
  return Math.round(n * 100_000_000) / 100_000_000;
}
