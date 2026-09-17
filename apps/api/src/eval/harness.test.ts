import { describe, expect, it } from 'vitest';
import { ALL_CASES, summarise } from './runner.ts';
import type { EvalOutcome } from './types.ts';

/**
 * The harness itself, without spending quota.
 *
 * The suites make real model calls and run from `npm run eval`. What belongs in
 * the ordinary test suite is the scaffolding around them — because a bug here
 * does not fail loudly, it reports a wrong number that nobody questions.
 */

const outcome = (over: Partial<EvalOutcome> & Pick<EvalOutcome, 'suite'>): EvalOutcome => ({
  caseId: `case-${Math.random()}`,
  passed: true,
  score: 1,
  detail: {},
  ...over,
});

describe('eval case registry', () => {
  it('has no duplicate case ids', () => {
    // Two cases sharing an id would silently overwrite each other in any
    // per-case comparison between runs — exactly the regression tracking this
    // suite exists to provide.
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every suite the database will accept', () => {
    // These must match the eval_results.suite check constraint, or a whole
    // suite's results fail to insert after the expensive part has run.
    const allowed = new Set(['tutor', 'retrieval', 'assessment', 'recommendation', 'security']);
    for (const c of ALL_CASES) expect(allowed.has(c.suite)).toBe(true);
  });

  it('covers every AI experience the PRD names', () => {
    const covered = new Set(ALL_CASES.map((c) => c.suite));
    for (const suite of ['tutor', 'retrieval', 'assessment', 'recommendation', 'security']) {
      expect(covered.has(suite as never)).toBe(true);
    }
  });

  it('gives every case an intent a human can read', () => {
    // The intent is what a failure report shows. "test tutor 3" would make a
    // red result unactionable.
    for (const c of ALL_CASES) {
      expect(c.intent.length).toBeGreaterThan(30);
      expect(c.id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
      expect(c.id.startsWith(`${c.suite}.`)).toBe(true);
    }
  });
});

describe('summarise', () => {
  it('counts passes and failures per suite', () => {
    const s = summarise([
      outcome({ suite: 'tutor', passed: true }),
      outcome({ suite: 'tutor', passed: false }),
      outcome({ suite: 'security', passed: true }),
    ]);
    expect(s.tutor).toMatchObject({ passed: 1, failed: 1 });
    expect(s.security).toMatchObject({ passed: 1, failed: 0 });
  });

  it('excludes unscored cases from the mean rather than counting them as zero', () => {
    // A pass/fail case has no score. Folding it in as 0 would drag the suite
    // mean down with cases that were never scored at all — and the number most
    // likely to be quoted is the one most likely to mislead.
    const s = summarise([
      outcome({ suite: 'tutor', score: 1 }),
      outcome({ suite: 'tutor', score: null }),
    ]);
    expect(s.tutor!.mean_score).toBe(1);
  });

  it('reports a null mean when nothing was scored', () => {
    const s = summarise([outcome({ suite: 'tutor', score: null })]);
    expect(s.tutor!.mean_score).toBeNull();
  });

  it('counts a thrown case as failed AND errored', () => {
    // A case that throws is a failure, but it is a different kind of failure
    // from one that ran and scored badly, and the report says which.
    const s = summarise([
      outcome({ suite: 'tutor', passed: false, score: null, detail: { errored: true, message: 'boom' } }),
      outcome({ suite: 'tutor', passed: false, score: 0.2 }),
    ]);
    expect(s.tutor).toMatchObject({ passed: 0, failed: 2, errored: 1 });
  });

  it('handles an empty run', () => {
    expect(summarise([])).toEqual({});
  });

  it('rounds the mean to four places', () => {
    const s = summarise([
      outcome({ suite: 'tutor', score: 1 / 3 }),
      outcome({ suite: 'tutor', score: 1 / 3 }),
    ]);
    expect(s.tutor!.mean_score).toBe(0.3333);
  });
});
