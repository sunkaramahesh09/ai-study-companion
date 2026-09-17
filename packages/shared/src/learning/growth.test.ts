import { describe, expect, it } from 'vitest';
import { analyseGrowth, growthPriority, type MasteryPoint } from './growth.ts';
import type { MasteryState } from './mastery.ts';

const T0 = new Date('2026-09-01T09:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const point = (score: number, n: number): MasteryPoint => ({ score, at: day(n) });
const state = (score: number, evidenceCount = 6): MasteryState => ({
  score,
  evidenceCount,
  lastEvidenceAt: day(5),
});

describe('analyseGrowth', () => {
  it('reports an unassessed concept as new, not as a weakness', () => {
    // 0.5 is "we do not know" (D-038); calling that a problem would be wrong.
    const g = analyseGrowth([], state(0.5, 0));
    expect(g.trend).toBe('new');
    expect(g.summary).toMatch(/not assessed/i);
  });

  it('treats a single data point as a position, not a trend', () => {
    const g = analyseGrowth([point(0.7, 0)], state(0.7, 1));
    expect(g.trend).toBe('new');
    expect(g.delta).toBe(0);
    expect(g.summary).toMatch(/not enough to see a trend/i);
  });

  it('flags a single bad data point as needing attention', () => {
    const g = analyseGrowth([point(0.2, 0)], state(0.2, 1));
    expect(g.trend).toBe('needs_attention');
  });

  it('detects genuine improvement', () => {
    const g = analyseGrowth([point(0.5, 0), point(0.62, 2), point(0.78, 4)], state(0.78));
    expect(g.trend).toBe('improving');
    expect(g.delta).toBeCloseTo(0.28, 4);
    expect(g.summary).toContain('78%');
  });

  it('detects decline as needing attention', () => {
    const g = analyseGrowth([point(0.8, 0), point(0.7, 2), point(0.6, 4)], state(0.6));
    expect(g.trend).toBe('needs_attention');
    expect(g.delta).toBeLessThan(0);
    expect(g.summary).toMatch(/down/i);
  });

  it('calls small movement stable rather than a trend', () => {
    // Mastery moves in small steps once evidence accumulates, so noise must not
    // read as progress.
    const g = analyseGrowth([point(0.7, 0), point(0.72, 2), point(0.71, 4)], state(0.71));
    expect(g.trend).toBe('stable');
  });

  it('prioritises poor standing over positive direction', () => {
    // Improving from 0.15 to 0.22 is technically improvement, but telling a
    // learner they are doing well while they miss most questions is misleading.
    const g = analyseGrowth([point(0.15, 0), point(0.22, 3)], state(0.22));
    expect(g.trend).toBe('needs_attention');
    expect(g.summary).toMatch(/improving.*but still the weakest/i);
  });

  it('distinguishes holding steady when secure from stagnating when not', () => {
    const secure = analyseGrowth([point(0.85, 0), point(0.86, 3)], state(0.86, 12));
    const middling = analyseGrowth([point(0.6, 0), point(0.61, 3)], state(0.61, 12));
    expect(secure.summary).toMatch(/holding steady/i);
    expect(middling.summary).toMatch(/more practice/i);
  });

  it('orders points by time regardless of input order', () => {
    const shuffled = [point(0.78, 4), point(0.5, 0), point(0.62, 2)];
    const g = analyseGrowth(shuffled, state(0.78));
    expect(g.from).toBe(0.5);
    expect(g.to).toBe(0.78);
    expect(g.trend).toBe('improving');
  });

  it('is deterministic', () => {
    const points = [point(0.4, 0), point(0.6, 2)];
    expect(analyseGrowth(points, state(0.6))).toEqual(analyseGrowth(points, state(0.6)));
  });

  it('never produces a summary the UI has to rewrite', () => {
    // Every branch returns a complete, learner-readable sentence.
    const cases = [
      analyseGrowth([], state(0.5, 0)),
      analyseGrowth([point(0.2, 0)], state(0.2, 1)),
      analyseGrowth([point(0.5, 0), point(0.8, 3)], state(0.8)),
      analyseGrowth([point(0.8, 0), point(0.5, 3)], state(0.5)),
      analyseGrowth([point(0.7, 0), point(0.71, 3)], state(0.71)),
    ];
    for (const c of cases) {
      expect(c.summary.length).toBeGreaterThan(10);
      expect(c.summary).toMatch(/\.$/);
    }
  });
});

describe('growthPriority', () => {
  it('leads with what needs work', () => {
    expect(growthPriority('needs_attention')).toBeGreaterThan(growthPriority('new'));
    expect(growthPriority('new')).toBeGreaterThan(growthPriority('stable'));
    expect(growthPriority('stable')).toBeGreaterThan(growthPriority('improving'));
  });
});
