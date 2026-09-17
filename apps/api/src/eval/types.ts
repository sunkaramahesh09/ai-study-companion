/**
 * Evaluation harness types (PRD §14).
 *
 * The suite names match the `eval_results.suite` check constraint in
 * `0004_ai_ops.sql`, so a typo is a database error rather than a row that
 * quietly lands in a category nobody looks at.
 */
export type Suite = 'tutor' | 'retrieval' | 'assessment' | 'recommendation' | 'security';

export type EvalContext = {
  projectId: string;
  userId: string;
  /** Service-role client. The harness owns its own fixture project. */
  db: import('@supabase/supabase-js').SupabaseClient;
};

export type EvalOutcome = {
  caseId: string;
  suite: Suite;
  passed: boolean;
  /**
   * 0..1 where a case is a matter of degree, null where it is a plain
   * pass/fail. Reporting 0 for "not scored" would drag every suite mean down
   * with cases that were never scored at all.
   */
  score: number | null;
  /** Everything needed to understand the verdict without re-running it. */
  detail: Record<string, unknown>;
};

export type EvalCase = {
  id: string;
  suite: Suite;
  /** What this case is actually protecting. Shown in the report. */
  intent: string;
  run: (ctx: EvalContext) => Promise<Omit<EvalOutcome, 'caseId' | 'suite'>>;
};

export type SuiteSummary = {
  passed: number;
  failed: number;
  errored: number;
  mean_score: number | null;
};
