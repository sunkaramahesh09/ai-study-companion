import { bucketByDay, groundingRate, summariseAiUsage, type AiRequestRow, type EventRow } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { replyDbError } from '../lib/errors.ts';
import { QUEUES, queue } from '../lib/queue.ts';

/**
 * Admin Dashboard (PRD §17): users, learning activity, AI usage, AI quality,
 * and system health.
 *
 * **How the gate works, and why it is not the API's opinion.** Every route
 * here sits behind `requireAdmin`, which reads `profiles.role` from the
 * database rather than from a JWT claim — a forged token cannot grant it
 * (verified in production with the SAME token before and after a DB
 * promotion). Underneath that, these handlers query through `req.db`, the
 * caller's own JWT, and the RLS policies widen for an admin via
 * `public.is_admin()`. So the reach of an admin query is decided by Postgres.
 *
 * That is deliberate: the service role would also return every row, but it
 * would return them to *anyone* who reached this code, making the route
 * handler the only thing standing between a bug and every user's data.
 */

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).catch(30),
});

const activityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).catch(30),
  limit: z.coerce.number().int().min(1).max(200).catch(100),
  userId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  type: z.string().max(64).optional(),
});

const ROW_LIMIT = 5000;

export const adminRoutes: FastifyPluginAsync = async (app) => {
  /** Headline numbers plus system health, in one request. */
  app.get('/api/admin/overview', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { days } = windowSchema.parse(req.query ?? {});
    const since = windowStart(days);

    const [profiles, spaces, projects, materials, events, ai, evalRuns] = await Promise.all([
      req.db!.from('profiles').select('id, role, created_at'),
      req.db!.from('spaces').select('id', { count: 'exact', head: true }),
      req.db!.from('projects').select('id', { count: 'exact', head: true }),
      req.db!.from('materials').select('status'),
      req
        .db!.from('learning_events')
        .select('event_type, created_at')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      req
        .db!.from('ai_requests')
        .select('feature, model, status, latency_ms, total_tokens, estimated_cost_usd, used_fallback')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      req
        .db!.from('eval_runs')
        .select('id, git_sha, notes, summary, started_at, finished_at')
        .order('started_at', { ascending: false })
        .limit(5),
    ]);
    if (profiles.error) return replyDbError(reply, profiles.error);

    const eventRows = toEventRows(events.data);
    const newUsers = (profiles.data ?? []).filter(
      (p) => new Date(p.created_at as string) >= since,
    ).length;

    return {
      window: { days, since: since.toISOString() },
      users: {
        total: (profiles.data ?? []).length,
        admins: (profiles.data ?? []).filter((p) => p.role === 'admin').length,
        newInWindow: newUsers,
      },
      content: {
        spaces: spaces.count ?? 0,
        projects: projects.count ?? 0,
        materials: (materials.data ?? []).length,
        // Material status IS the pipeline's user-visible truth, independent of
        // whatever the queue believes. A material stuck in `processing` with an
        // empty queue is the signal that a worker died mid-job.
        materialsByStatus: countBy(materials.data ?? [], (m) => m.status as string),
      },
      activity: {
        buckets: bucketByDay(eventRows, { days }),
        totalEvents: eventRows.length,
        byType: countBy(eventRows, (e) => e.type),
      },
      tutor: groundingRate(eventRows),
      ai: summariseAiUsage(toAiRows(ai.data)),
      jobs: await jobHealth(),
      evaluation: {
        runs: evalRuns.data ?? [],
        // Task 22 populates this. Reporting "never run" is more useful than an
        // empty section that looks like a rendering bug.
        lastRunAt: (evalRuns.data ?? [])[0]?.started_at ?? null,
      },
    };
  });

  /** Users with their footprint, so a support question has an answer. */
  app.get('/api/admin/users', { preHandler: app.requireAdmin }, async (req, reply) => {
    const [profiles, spaces, projects, events, ai] = await Promise.all([
      req.db!.from('profiles').select('id, email, role, created_at').order('created_at', { ascending: false }),
      req.db!.from('spaces').select('user_id'),
      req.db!.from('projects').select('user_id'),
      req.db!.from('learning_events').select('user_id').limit(ROW_LIMIT),
      req.db!.from('ai_requests').select('user_id, total_tokens, estimated_cost_usd').limit(ROW_LIMIT),
    ]);
    if (profiles.error) return replyDbError(reply, profiles.error);

    const spaceCount = countBy(spaces.data ?? [], (s) => s.user_id as string);
    const projectCount = countBy(projects.data ?? [], (p) => p.user_id as string);
    const eventCount = countBy(events.data ?? [], (e) => e.user_id as string);

    const tokensByUser = new Map<string, { tokens: number; cost: number }>();
    for (const r of ai.data ?? []) {
      const id = r.user_id as string | null;
      if (!id) continue;
      const cur = tokensByUser.get(id) ?? { tokens: 0, cost: 0 };
      cur.tokens += Number(r.total_tokens ?? 0);
      cur.cost += Number(r.estimated_cost_usd ?? 0);
      tokensByUser.set(id, cur);
    }

    return {
      users: (profiles.data ?? []).map((p) => {
        const usage = tokensByUser.get(p.id as string);
        return {
          id: p.id as string,
          email: p.email as string | null,
          role: p.role as string,
          createdAt: p.created_at as string,
          spaces: spaceCount[p.id as string] ?? 0,
          projects: projectCount[p.id as string] ?? 0,
          events: eventCount[p.id as string] ?? 0,
          tokens: usage?.tokens ?? 0,
          estimatedCostUsd: round8(usage?.cost ?? 0),
        };
      }),
    };
  });

  /** Filterable activity feed across every user. */
  app.get('/api/admin/activity', { preHandler: app.requireAdmin }, async (req, reply) => {
    const q = activityQuerySchema.parse(req.query ?? {});
    let query = req
      .db!.from('learning_events')
      .select('id, user_id, project_id, event_type, payload, created_at')
      .gte('created_at', windowStart(q.days).toISOString())
      .order('created_at', { ascending: false })
      .limit(q.limit);

    if (q.userId) query = query.eq('user_id', q.userId);
    if (q.projectId) query = query.eq('project_id', q.projectId);
    if (q.type) query = query.eq('event_type', q.type);

    const { data, error } = await query;
    if (error) return replyDbError(reply, error);
    return { events: data ?? [], filters: q };
  });

  /**
   * AI request detail — the "why was it slow / which model / what did it cost"
   * view the PRD asks to be answerable (§14). Failures first: a summary is for
   * noticing a problem, this is for chasing one.
   */
  app.get('/api/admin/ai', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { days } = windowSchema.parse(req.query ?? {});
    const since = windowStart(days);

    const [all, failures] = await Promise.all([
      req
        .db!.from('ai_requests')
        .select('feature, model, status, latency_ms, total_tokens, estimated_cost_usd, used_fallback')
        .gte('created_at', since.toISOString())
        .limit(ROW_LIMIT),
      req
        .db!.from('ai_requests')
        .select(
          'id, user_id, project_id, feature, model, status, latency_ms, attempt_count, error_code, error_message, created_at',
        )
        .neq('status', 'success')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    if (all.error) return replyDbError(reply, all.error);

    return {
      window: { days, since: since.toISOString() },
      summary: summariseAiUsage(toAiRows(all.data)),
      recentFailures: failures.data ?? [],
    };
  });

  /** Evaluation history. Populated by task 22's `npm run eval`. */
  app.get('/api/admin/evals', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { data: runs, error } = await req
      .db!.from('eval_runs')
      .select('id, git_sha, notes, summary, started_at, finished_at')
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) return replyDbError(reply, error);

    const latest = (runs ?? [])[0];
    const { data: results } = latest
      ? await req
          .db!.from('eval_results')
          .select('id, suite, case_id, passed, score, detail, created_at')
          .eq('run_id', latest.id)
          .order('suite')
      : { data: [] };

    // A run that started and never finished is a crashed run, and saying so is
    // more useful than showing its partial numbers as if they were the result.
    return {
      runs: (runs ?? []).map((r) => ({ ...r, incomplete: r.finished_at === null })),
      latestResults: results ?? [],
      latestRunId: latest?.id ?? null,
    };
  });
};

/**
 * Queue depth and failures straight from pg-boss.
 *
 * Wrapped because the admin dashboard must still render when the queue is
 * unreachable — an observability page that goes blank exactly when something
 * is wrong is worse than useless. The error is reported as data.
 */
async function jobHealth(): Promise<{
  available: boolean;
  error: string | null;
  queues: { name: string; queued: number; active: number; failed: number; total: number }[];
}> {
  try {
    const boss = await queue();
    const known = Object.values(QUEUES) as string[];
    const queues = await boss.getQueues(known);
    return {
      available: true,
      error: null,
      queues: queues.map((q) => ({
        name: q.name,
        queued: q.queuedCount ?? 0,
        active: q.activeCount ?? 0,
        // Retained failures, bounded by the queue's retention policy — a
        // rolling recent count, not an all-time total.
        failed: q.failedCount ?? 0,
        total: q.totalCount ?? 0,
      })),
    };
  } catch (err) {
    return { available: false, error: (err as Error).message, queues: [] };
  }
}

// --- helpers ---------------------------------------------------------------

function windowStart(days: number): Date {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * 86_400_000);
}

function toEventRows(rows: { event_type: unknown; created_at: unknown }[] | null): EventRow[] {
  return (rows ?? []).map((e) => ({ type: e.event_type as string, at: new Date(e.created_at as string) }));
}

function toAiRows(rows: Record<string, unknown>[] | null): AiRequestRow[] {
  return (rows ?? []).map((r) => ({
    feature: r.feature as string,
    model: r.model as string,
    status: r.status as string,
    latencyMs: nullableNumber(r.latency_ms),
    totalTokens: nullableNumber(r.total_tokens),
    estimatedCostUsd: nullableNumber(r.estimated_cost_usd),
    usedFallback: Boolean(r.used_fallback),
  }));
}

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function round8(n: number): number {
  return Math.round(n * 100_000_000) / 100_000_000;
}
