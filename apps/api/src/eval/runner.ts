import { execSync } from 'node:child_process';
import { summariseAiUsage } from '@asc/shared';
import { serviceClient } from '../lib/supabase.ts';
import { setupFixture } from './fixture.ts';
import { assessmentCases } from './suites/assessment.ts';
import { recommendationCases } from './suites/recommendation.ts';
import { retrievalCases } from './suites/retrieval.ts';
import { securityCases } from './suites/security.ts';
import { tutorCases } from './suites/tutor.ts';
import type { EvalCase, EvalOutcome, Suite, SuiteSummary } from './types.ts';

export const ALL_CASES: EvalCase[] = [
  ...retrievalCases,
  ...tutorCases,
  ...assessmentCases,
  ...recommendationCases,
  ...securityCases,
];

/** What one evaluation run actually spent. */
export type EvalCost = {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byFeature: { feature: string; requests: number; totalTokens: number }[];
};

export type EvalRunResult = {
  runId: string | null;
  outcomes: EvalOutcome[];
  summary: Record<string, SuiteSummary>;
  cost: EvalCost | null;
  passed: number;
  failed: number;
  durationMs: number;
};

export type RunOptions = {
  /** Restrict to one suite, for iterating on a failure without paying for all of them. */
  suite?: Suite;
  /** Skip persistence — used by the unit test that checks the harness itself. */
  persist?: boolean;
  onProgress?: (message: string) => void;
};

/**
 * Runs the curated cases and persists the result.
 *
 * **Cases run sequentially, on purpose.** Groq's binding constraint is 8000
 * TPM, not RPM, and a Tutor answer costs roughly 3000 tokens. Running the
 * suites in parallel would spend the whole minute's budget in a few seconds
 * and spend the rest of the run in backoff — slower overall, and with 429s
 * polluting the very AI-health numbers the admin dashboard reads.
 *
 * **A thrown case is recorded as a failure, never as a crash.** A suite that
 * dies on its third case tells you nothing about the other twelve, and the
 * regressions this exists to catch are exactly the kind that throw.
 */
export async function runEvaluation(options: RunOptions = {}): Promise<EvalRunResult> {
  const startedAt = new Date();
  const log = options.onProgress ?? (() => {});
  const cases = options.suite ? ALL_CASES.filter((c) => c.suite === options.suite) : ALL_CASES;
  if (cases.length === 0) throw new Error(`No cases for suite "${options.suite}".`);

  const db = serviceClient();
  const persist = options.persist !== false;
  let cost: EvalCost | null = null;

  let runId: string | null = null;
  if (persist) {
    const { data, error } = await db
      .from('eval_runs')
      .insert({
        git_sha: gitSha(),
        notes: options.suite ? `suite=${options.suite}` : null,
        started_at: startedAt.toISOString(),
      })
      .select('id')
      .single();
    if (error) throw new Error(`could not open an eval run: ${error.message}`);
    runId = data!.id as string;
  }

  log(`Setting up the evaluation fixture…`);
  const fixture = await setupFixture();
  const outcomes: EvalOutcome[] = [];

  try {
    for (const [index, testCase] of cases.entries()) {
      log(`[${index + 1}/${cases.length}] ${testCase.id}`);
      try {
        const result = await testCase.run({
          db,
          projectId: fixture.projectId,
          userId: fixture.userId,
        });
        outcomes.push({ caseId: testCase.id, suite: testCase.suite, ...result });
      } catch (err) {
        outcomes.push({
          caseId: testCase.id,
          suite: testCase.suite,
          passed: false,
          score: null,
          detail: { errored: true, message: (err as Error).message, stack: (err as Error).stack?.slice(0, 600) },
        });
      }
    }
    cost = await captureCost(db, fixture.projectId, startedAt);
  } finally {
    // The run's CONTENT is removed whatever happened, so the next run cannot
    // score against this one's leftovers — which would hide a retrieval
    // regression behind a previous run's chunks.
    await fixture.cleanup();
  }

  const summary = summarise(outcomes);
  const finishedAt = new Date();

  if (persist && runId) {
    const { error: resultsError } = await db.from('eval_results').insert(
      outcomes.map((o) => ({
        run_id: runId,
        suite: o.suite,
        case_id: o.caseId,
        passed: o.passed,
        score: o.score,
        detail: o.detail,
      })),
    );
    if (resultsError) log(`warning: results not persisted — ${resultsError.message}`);

    // `finished_at` is written last and is what marks a run complete. A run
    // that crashed mid-way leaves it null, and the admin view reports "did not
    // finish" rather than presenting partial numbers as a result.
    await db
      .from('eval_runs')
      .update({ summary: { ...summary, _cost: cost }, finished_at: finishedAt.toISOString() })
      .eq('id', runId);
  }

  return {
    runId,
    outcomes,
    summary,
    cost,
    passed: outcomes.filter((o) => o.passed).length,
    failed: outcomes.filter((o) => !o.passed).length,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

export function summarise(outcomes: EvalOutcome[]): Record<string, SuiteSummary> {
  const out: Record<string, SuiteSummary> = {};
  for (const suite of new Set(outcomes.map((o) => o.suite))) {
    const slice = outcomes.filter((o) => o.suite === suite);
    // Unscored cases are excluded from the mean rather than counted as zero —
    // a pass/fail case has no score, and folding it in as 0 would drag the
    // suite mean down with cases that were never scored at all.
    const scored = slice.map((o) => o.score).filter((s): s is number => s !== null);
    out[suite] = {
      passed: slice.filter((o) => o.passed).length,
      failed: slice.filter((o) => !o.passed).length,
      errored: slice.filter((o) => o.detail.errored === true).length,
      mean_score:
        scored.length > 0
          ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10_000) / 10_000
          : null,
    };
  }
  return out;
}

/** Ties a result to the code that produced it — the point of tracking regressions. */
function gitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Records what the run spent, BEFORE the fixture is torn down.
 *
 * `ai_requests.project_id` cascades on delete, so removing the fixture project
 * takes the run's usage rows with it. That is the right behaviour for the
 * table — usage is attributed to a project, and the project is gone — but it
 * means "what did evaluation cost?" has to be answered somewhere that outlives
 * the fixture. The run record is the natural home, and it is where the admin
 * dashboard already looks. See D-054.
 *
 * Providers record usage fire-and-forget, so a short settle gives the last
 * call's write time to land. A missed row understates the cost slightly; it
 * cannot corrupt anything.
 */
async function captureCost(
  db: ReturnType<typeof serviceClient>,
  projectId: string,
  since: Date,
): Promise<EvalCost | null> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const { data, error } = await db
    .from('ai_requests')
    .select('feature, model, status, latency_ms, total_tokens, estimated_cost_usd, used_fallback')
    .eq('project_id', projectId)
    .gte('created_at', since.toISOString());
  if (error || !data) return null;

  const usage = summariseAiUsage(
    data.map((r) => ({
      feature: r.feature as string,
      model: r.model as string,
      status: r.status as string,
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      totalTokens: r.total_tokens === null ? null : Number(r.total_tokens),
      estimatedCostUsd: r.estimated_cost_usd === null ? null : Number(r.estimated_cost_usd),
      usedFallback: Boolean(r.used_fallback),
    })),
  );

  return {
    requests: usage.requests,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    byFeature: usage.byFeature.map((f) => ({
      feature: f.feature,
      requests: f.requests,
      totalTokens: f.totalTokens,
    })),
  };
}
