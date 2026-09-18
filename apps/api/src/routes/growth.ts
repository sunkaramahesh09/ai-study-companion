import { analyseGrowth, growthPriority, masteryBand, masteryConfidence, type MasteryPoint, type MasteryState } from '@asc/shared';
import { uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { parseOrReply, replyDbError } from '../lib/errors.ts';

/**
 * How much mastery history a single request reads, newest first.
 *
 * A trend does not get more truthful with more points, and this bounds the
 * response for a project that has been quizzed heavily.
 */
const HISTORY_WINDOW = 500;

/** Points sent to the client per concept — what a 64px sparkline can show. */
const SPARKLINE_POINTS = 40;

export const growthRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Growth analysis for a project.
   *
   * Trends are computed from `mastery_history` on read, not stored. That means
   * changing how growth is judged re-reads the same evidence rather than
   * losing it, and the classification can never drift out of sync with the
   * scores it describes. See D-049.
   */
  app.get('/api/projects/:id/growth', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: project, error } = await req
      .db!.from('projects')
      .select('id, name')
      .eq('id', params.id)
      .eq('user_id', req.user!.id)
      .single();
    if (error || !project) return replyDbError(reply, error ?? { message: 'not found', code: 'PGRST116' });

    const [{ data: concepts }, { data: mastery }, { data: history }] = await Promise.all([
      req.db!.from('concepts').select('id, name, description').eq('project_id', params.id).order('name'),
      req.db!.from('concept_mastery').select('concept_id, score, evidence_count, last_evidence_at').eq('project_id', params.id),
      // Newest first, then reversed below. Ordering ascending here would cap
      // the window at the OLDEST 500 rows, so a project past 500 assessments
      // would show a trend frozen at its earliest history while the current
      // score kept moving — a wrong answer that looks like a right one.
      req
        .db!.from('mastery_history')
        .select('concept_id, score_after, created_at')
        .eq('project_id', params.id)
        .order('created_at', { ascending: false })
        .limit(HISTORY_WINDOW),
    ]);

    const masteryByConcept = new Map<string, MasteryState>();
    for (const m of mastery ?? []) {
      masteryByConcept.set(m.concept_id as string, {
        score: Number(m.score),
        evidenceCount: Number(m.evidence_count),
        lastEvidenceAt: m.last_evidence_at ? new Date(m.last_evidence_at as string) : null,
      });
    }

    const pointsByConcept = new Map<string, MasteryPoint[]>();
    // Reverse back to chronological order — `analyseGrowth` sorts defensively,
    // but the sparkline reads this array as given.
    for (const h of [...(history ?? [])].reverse()) {
      const list = pointsByConcept.get(h.concept_id as string) ?? [];
      list.push({ score: Number(h.score_after), at: new Date(h.created_at as string) });
      pointsByConcept.set(h.concept_id as string, list);
    }

    const now = new Date();
    const rows = (concepts ?? []).map((c) => {
      const conceptId = c.id as string;
      const state = masteryByConcept.get(conceptId) ?? {
        score: 0.5,
        evidenceCount: 0,
        lastEvidenceAt: null,
      };
      const growth = analyseGrowth(pointsByConcept.get(conceptId) ?? [], state);
      return {
        conceptId,
        name: c.name as string,
        description: c.description as string | null,
        score: state.score,
        evidenceCount: state.evidenceCount,
        // Surfaced so the UI can distinguish "72% from one answer" from "72%
        // from fifteen". Mastery is an estimate (PRD §10).
        confidence: masteryConfidence(state, now),
        band: masteryBand(state, now),
        growth,
        // The full window drives the analysis; the client only gets what a
        // sparkline can render, so a heavily-assessed project does not ship a
        // payload dominated by invisible points.
        history: (pointsByConcept.get(conceptId) ?? []).slice(-SPARKLINE_POINTS).map((p) => ({
          score: p.score,
          at: p.at.toISOString(),
        })),
      };
    });

    // Lead with what needs work, then weakest first within a trend.
    rows.sort(
      (a, b) =>
        growthPriority(b.growth.trend) - growthPriority(a.growth.trend) ||
        a.score - b.score ||
        a.name.localeCompare(b.name),
    );

    const assessed = rows.filter((r) => r.evidenceCount > 0);
    return {
      project: { id: project.id, name: project.name },
      concepts: rows,
      summary: {
        total: rows.length,
        assessed: assessed.length,
        improving: rows.filter((r) => r.growth.trend === 'improving').length,
        stable: rows.filter((r) => r.growth.trend === 'stable').length,
        needsAttention: rows.filter((r) => r.growth.trend === 'needs_attention').length,
        // Only over concepts with evidence: averaging in the 0.5 prior of
        // untested concepts would report a confident-looking number built
        // mostly from placeholders.
        averageMastery:
          assessed.length > 0
            ? Math.round((assessed.reduce((s, r) => s + r.score, 0) / assessed.length) * 10_000) / 10_000
            : null,
      },
    };
  });

  /** Active recommendations for a project. */
  app.get('/api/projects/:id/recommendations', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const { data, error } = await req
      .db!.from('recommendations')
      .select('id, title, body, action_type, trigger_reason, concept_id, created_at')
      .eq('project_id', params.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) return replyDbError(reply, error);
    return { recommendations: data };
  });

  /** Dismiss or complete a recommendation. */
  app.patch('/api/recommendations/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const status = (req.body as { status?: string } | undefined)?.status;
    if (status !== 'dismissed' && status !== 'completed') {
      return reply.code(400).send({ error: 'invalid_request', message: 'status must be dismissed or completed.' });
    }
    const { data, error } = await req
      .db!.from('recommendations')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', params.id)
      .select('id');
    if (error) return replyDbError(reply, error);
    if (!data || data.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return { ok: true };
  });
};
