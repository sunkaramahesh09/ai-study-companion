import {
  bucketByDay,
  groundingRate,
  studyStreak,
  summariseAiUsage,
  summariseAssessment,
  uuidParamSchema,
  type AiRequestRow,
  type AnswerRow,
  type EventRow,
} from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';

/**
 * Project and Global analytics (PRD §12).
 *
 * Everything here is arithmetic over rows already being written — nothing in
 * this file emits an event or calls a model. The aggregation itself lives in
 * `@asc/shared` as pure functions, so the numbers a learner sees are unit
 * tested without a database; these handlers only fetch and hand over.
 *
 * Reads go through `req.db` (the caller's JWT), so Postgres enforces isolation
 * on every one of them rather than this file remembering to.
 */

const windowSchema = z.object({
  // Capped rather than rejected above the cap: a client asking for a year of
  // daily buckets gets 90 days, not a 400. The window is a presentation
  // choice, not a correctness constraint.
  days: z.coerce.number().int().min(1).max(90).catch(30),
});

/** Row cap per table per request. Enough for a 90-day window of real use. */
const ROW_LIMIT = 2000;

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  /** Everything the Project Analytics view needs, in one request. */
  app.get('/api/projects/:id/analytics', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const { days } = windowSchema.parse(req.query ?? {});
    const since = windowStart(days);

    const { data: project, error } = await req
      .db!.from('projects')
      .select('id, name')
      .eq('id', params.id)
      .eq('user_id', req.user!.id)
      .single();
    if (error || !project) return replyDbError(reply, error ?? { message: 'not found', code: 'PGRST116' });

    const [{ data: events }, { data: answers }, { data: ai }, { data: attempts }, { data: mastery }] =
      await Promise.all([
        req
          .db!.from('learning_events')
          .select('event_type, created_at')
          .eq('project_id', params.id)
          .gte('created_at', since.toISOString())
          .order('created_at', { ascending: false })
          .limit(ROW_LIMIT),
        req
          .db!.from('quiz_questions')
          .select('question_type, difficulty, is_correct, score, answered_at')
          .eq('project_id', params.id)
          .not('answered_at', 'is', null)
          .order('answered_at', { ascending: false })
          .limit(ROW_LIMIT),
        req
          .db!.from('ai_requests')
          .select('feature, model, status, latency_ms, total_tokens, estimated_cost_usd, used_fallback')
          .eq('project_id', params.id)
          .gte('created_at', since.toISOString())
          .order('created_at', { ascending: false })
          .limit(ROW_LIMIT),
        req
          .db!.from('quiz_attempts')
          .select('status, score, questions_answered, started_at, completed_at')
          .eq('project_id', params.id)
          .order('started_at', { ascending: false })
          .limit(50),
        req
          .db!.from('concept_mastery')
          .select('score, evidence_count')
          .eq('project_id', params.id),
      ]);

    const eventRows = toEventRows(events);
    const buckets = bucketByDay(eventRows, { days });

    const assessed = (mastery ?? []).filter((m) => Number(m.evidence_count) > 0);
    const completed = (attempts ?? []).filter((a) => a.status === 'completed');

    return {
      project: { id: project.id, name: project.name },
      window: { days, since: since.toISOString() },
      activity: {
        buckets,
        streak: studyStreak(buckets),
        totalEvents: eventRows.length,
        byType: countByType(eventRows),
      },
      assessment: {
        ...summariseAssessment(toAnswerRows(answers)),
        attempts: {
          total: (attempts ?? []).length,
          completed: completed.length,
          abandoned: (attempts ?? []).filter((a) => a.status === 'abandoned').length,
          inProgress: (attempts ?? []).filter((a) => a.status === 'in_progress').length,
          // Abandoned attempts have no score; averaging them in as zero would
          // report walking away as failing.
          averageScore: average(completed.map((a) => Number(a.score)).filter(Number.isFinite)),
        },
      },
      mastery: {
        concepts: (mastery ?? []).length,
        assessed: assessed.length,
        average: average(assessed.map((m) => Number(m.score))),
      },
      tutor: groundingRate(eventRows),
      ai: summariseAiUsage(toAiRows(ai)),
    };
  });

  /**
   * Global analytics: learning activity aggregated across every Space and
   * Project the caller owns, plus a per-project breakdown so the numbers are
   * traceable back to where they came from.
   *
   * Deliberately WITHOUT AI usage, unlike the per-project view above. The PRD
   * asks for AI activity on Project Analytics (§12) — where it is about this
   * Project's own material and answers — and puts platform-wide AI usage under
   * the Admin Dashboard (§16). A learner's account-wide token spend, model mix
   * and dollar cost is an operator's view of the system, not a learner's view
   * of their learning: there is no study decision that changes because the p95
   * latency moved. See D-076.
   */
  app.get('/api/analytics', { preHandler: app.requireAuth }, async (req, reply) => {
    const { days } = windowSchema.parse(req.query ?? {});
    const since = windowStart(days);

    const [{ data: spaces }, { data: projects }, { data: events, error: eventsError }, { data: answers }] =
      await Promise.all([
        // Every one of these filters on user_id. This endpoint has no project
        // in its path to hang ownership off, so RLS was the only thing scoping
        // it — and an admin's policy matches every row, which is how the
        // admin's own dashboard came to show another learner's totals (D-073).
        req.db!.from('spaces').select('id').eq('user_id', req.user!.id),
        req.db!.from('projects').select('id, name, space_id').eq('user_id', req.user!.id),
        req
          .db!.from('learning_events')
          .select('event_type, created_at, project_id')
          .eq('user_id', req.user!.id)
          .gte('created_at', since.toISOString())
          .order('created_at', { ascending: false })
          .limit(ROW_LIMIT),
        req
          .db!.from('quiz_questions')
          .select('question_type, difficulty, is_correct, score, answered_at')
          .eq('user_id', req.user!.id)
          .not('answered_at', 'is', null)
          .order('answered_at', { ascending: false })
          .limit(ROW_LIMIT),
      ]);
    if (eventsError) return replyDbError(reply, eventsError);

    const eventRows = toEventRows(events);
    const buckets = bucketByDay(eventRows, { days });

    // Per-project event counts, so a global figure can be traced to its source
    // rather than being a number the user has to take on faith.
    const perProject = new Map<string, number>();
    for (const e of events ?? []) {
      const id = e.project_id as string | null;
      if (id) perProject.set(id, (perProject.get(id) ?? 0) + 1);
    }

    return {
      window: { days, since: since.toISOString() },
      totals: {
        spaces: (spaces ?? []).length,
        projects: (projects ?? []).length,
      },
      activity: {
        buckets,
        streak: studyStreak(buckets),
        totalEvents: eventRows.length,
        byType: countByType(eventRows),
      },
      assessment: summariseAssessment(toAnswerRows(answers)),
      // Kept: how often the Tutor could answer from the learner's own material
      // is a fact about their material, and "upload more" is a real action.
      tutor: groundingRate(eventRows),
      projects: (projects ?? [])
        .map((p) => ({
          id: p.id as string,
          name: p.name as string,
          spaceId: p.space_id as string,
          events: perProject.get(p.id as string) ?? 0,
        }))
        .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name)),
    };
  });
};

// --- row mapping -----------------------------------------------------------

function windowStart(days: number): Date {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * 86_400_000);
}

function toEventRows(rows: { event_type: unknown; created_at: unknown }[] | null): EventRow[] {
  return (rows ?? []).map((e) => ({ type: e.event_type as string, at: new Date(e.created_at as string) }));
}

function toAnswerRows(rows: Record<string, unknown>[] | null): AnswerRow[] {
  return (rows ?? []).map((q) => ({
    isCorrect: q.is_correct as boolean | null,
    difficulty: Number(q.difficulty),
    questionType: q.question_type as 'mcq' | 'open',
    score: q.score === null || q.score === undefined ? null : Number(q.score),
    answeredAt: q.answered_at ? new Date(q.answered_at as string) : null,
  }));
}

function toAiRows(rows: Record<string, unknown>[] | null): AiRequestRow[] {
  return (rows ?? []).map((r) => ({
    feature: r.feature as string,
    model: r.model as string,
    status: r.status as string,
    latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
    totalTokens: r.total_tokens === null || r.total_tokens === undefined ? null : Number(r.total_tokens),
    estimatedCostUsd:
      r.estimated_cost_usd === null || r.estimated_cost_usd === undefined ? null : Number(r.estimated_cost_usd),
    usedFallback: Boolean(r.used_fallback),
  }));
}

function countByType(rows: EventRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

/** Mean, or null when there is nothing to average — never a misleading zero. */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10_000) / 10_000;
}
