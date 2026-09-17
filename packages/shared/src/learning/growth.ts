import { masteryBand, type MasteryState } from './mastery.ts';

/**
 * Growth analysis. Deterministic — no AI, no I/O.
 *
 * The PRD asks for concepts to be classified as improving, stable, or requiring
 * attention (§10). The classification is derived from `mastery_history` rather
 * than stored as a flag, so changing how growth is judged re-reads the same
 * evidence instead of losing it.
 */

export type MasteryPoint = {
  score: number;
  at: Date;
};

export type GrowthTrend = 'new' | 'improving' | 'stable' | 'needs_attention';

export type GrowthAnalysis = {
  trend: GrowthTrend;
  /** Change across the window, positive or negative. */
  delta: number;
  /** Where it started and finished, for a sparkline or a sentence. */
  from: number;
  to: number;
  points: number;
  /** Plain-language reason, so the UI never has to invent an explanation. */
  summary: string;
};

/**
 * How much movement counts as a trend rather than noise.
 *
 * Mastery updates are deliberately small once evidence accumulates (D-038), so
 * this has to be low enough to register genuine progress. 0.05 is roughly one
 * confident answer's worth of movement at moderate evidence.
 */
const TREND_THRESHOLD = 0.05;

/**
 * Below this, a concept needs attention regardless of direction.
 *
 * A learner improving from 0.15 to 0.22 is technically improving, but telling
 * them so — while they still get most questions wrong — would be misleading.
 * Absolute standing wins over direction when standing is poor.
 */
const ATTENTION_CEILING = 0.45;

export function analyseGrowth(points: MasteryPoint[], current: MasteryState): GrowthAnalysis {
  const ordered = [...points].sort((a, b) => a.at.getTime() - b.at.getTime());

  // No evidence at all: not a trend, and not a weakness either.
  if (current.evidenceCount === 0 || ordered.length === 0) {
    return {
      trend: 'new',
      delta: 0,
      from: current.score,
      to: current.score,
      points: 0,
      summary: 'Not assessed yet.',
    };
  }

  const from = ordered[0]!.score;
  const to = ordered[ordered.length - 1]!.score;
  const delta = round4(to - from);

  // A single data point is a position, not a trend.
  if (ordered.length < 2) {
    return {
      trend: to < ATTENTION_CEILING ? 'needs_attention' : 'new',
      delta: 0,
      from,
      to,
      points: ordered.length,
      summary:
        to < ATTENTION_CEILING
          ? 'Only one piece of evidence so far, and it did not go well.'
          : 'Only one piece of evidence so far — not enough to see a trend.',
    };
  }

  const band = masteryBand(current, ordered[ordered.length - 1]!.at);

  if (to < ATTENTION_CEILING) {
    return {
      trend: 'needs_attention',
      delta,
      from,
      to,
      points: ordered.length,
      summary:
        delta > TREND_THRESHOLD
          ? `Improving (${formatDelta(delta)}) but still the weakest area.`
          : `Sitting at ${pct(to)} and not improving.`,
    };
  }

  if (delta > TREND_THRESHOLD) {
    return {
      trend: 'improving',
      delta,
      from,
      to,
      points: ordered.length,
      summary: `Up ${formatDelta(delta)} to ${pct(to)} across ${ordered.length} assessments.`,
    };
  }

  if (delta < -TREND_THRESHOLD) {
    return {
      trend: 'needs_attention',
      delta,
      from,
      to,
      points: ordered.length,
      summary: `Down ${formatDelta(Math.abs(delta))} from ${pct(from)} — worth revisiting.`,
    };
  }

  return {
    trend: 'stable',
    delta,
    from,
    to,
    points: ordered.length,
    summary:
      band === 'secure'
        ? `Holding steady at ${pct(to)}.`
        : `Steady at ${pct(to)} — more practice would move it.`,
  };
}

/** Orders concepts so the dashboard leads with what needs work. */
export function growthPriority(trend: GrowthTrend): number {
  switch (trend) {
    case 'needs_attention':
      return 3;
    case 'new':
      return 2;
    case 'stable':
      return 1;
    default:
      return 0;
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatDelta(n: number): string {
  return `${Math.round(Math.abs(n) * 100)} points`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
