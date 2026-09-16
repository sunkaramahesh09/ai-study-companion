import { projectCreateSchema, projectUpdateSchema, uuidParamSchema } from '@asc/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { recordEvent } from '../lib/events.ts';
import { parseOrReply, replyDbError } from '../lib/errors.ts';

const SELECT = 'id, space_id, name, description, goal, created_at, updated_at, last_active_at';

type Row = {
  id: string;
  space_id: string;
  name: string;
  description: string | null;
  goal: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string;
};

const toProject = (r: Row) => ({
  id: r.id,
  spaceId: r.space_id,
  name: r.name,
  description: r.description,
  goal: r.goal,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastActiveAt: r.last_active_at,
});

const listQuerySchema = z.object({ spaceId: z.string().uuid().optional() });

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/projects', { preHandler: app.requireAuth }, async (req, reply) => {
    const query = parseOrReply(listQuerySchema, req.query, reply);
    if (!query) return;

    let q = req.db!.from('projects').select(SELECT).order('last_active_at', { ascending: false });
    if (query.spaceId) q = q.eq('space_id', query.spaceId);

    const { data, error } = await q;
    if (error) return replyDbError(reply, error);
    return { projects: (data as Row[]).map(toProject) };
  });

  /**
   * Project dashboard payload. One request, because the dashboard needs the
   * project plus its current learning state, and five round trips from the
   * browser would be slower than one fan-out here.
   *
   * Counts are placeholders in the sense that the underlying features land in
   * later tasks; the shape is fixed now so the frontend does not need reworking
   * when materials, mastery and recommendations start producing rows.
   */
  app.get('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: project, error } = await req
      .db!.from('projects')
      .select(SELECT)
      .eq('id', params.id)
      .single();

    if (error) return replyDbError(reply, error);

    const db = req.db!;
    const [materials, concepts, mastery, recommendations, activity] = await Promise.all([
      db.from('materials').select('id, filename, status, page_count, chunk_count, created_at')
        .eq('project_id', params.id).order('created_at', { ascending: false }).limit(20),
      db.from('concepts').select('id', { count: 'exact', head: true }).eq('project_id', params.id),
      db.from('concept_mastery').select('concept_id, score, evidence_count, concepts(name)')
        .eq('project_id', params.id).order('score', { ascending: true }).limit(10),
      db.from('recommendations').select('id, title, body, action_type, concept_id, created_at')
        .eq('project_id', params.id).eq('status', 'active')
        .order('created_at', { ascending: false }).limit(3),
      db.from('learning_events').select('id, event_type, payload, created_at')
        .eq('project_id', params.id).order('created_at', { ascending: false }).limit(10),
    ]);

    return {
      project: toProject(project as Row),
      materials: materials.data ?? [],
      conceptCount: concepts.count ?? 0,
      mastery: mastery.data ?? [],
      recommendations: recommendations.data ?? [],
      recentActivity: activity.data ?? [],
    };
  });

  app.post('/api/projects', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parseOrReply(projectCreateSchema, req.body, reply);
    if (!body) return;

    const { data, error } = await req
      .db!.from('projects')
      .insert({
        space_id: body.spaceId,
        user_id: req.user!.id,
        name: body.name,
        description: body.description ?? null,
        goal: body.goal ?? null,
      })
      .select(SELECT)
      .single();

    if (error) {
      // The projects_insert policy also asserts owns_space(), so pointing
      // space_id at someone else's Space is refused by the database rather
      // than by a check here. 42501/PGRST301 map to 403.
      return replyDbError(reply, error);
    }

    const project = toProject(data as Row);
    await recordEvent({
      userId: req.user!.id,
      type: 'project_created',
      projectId: project.id,
      spaceId: project.spaceId,
      payload: { name: project.name, hasGoal: Boolean(project.goal) },
      idempotencyKey: `project_created:${project.id}`,
    });

    return reply.code(201).send({ project });
  });

  app.patch('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const body = parseOrReply(projectUpdateSchema, req.body, reply);
    if (!body) return;

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.goal !== undefined) patch.goal = body.goal;

    const { data, error } = await req
      .db!.from('projects')
      .update(patch)
      .eq('id', params.id)
      .select(SELECT)
      .single();

    if (error) return replyDbError(reply, error);
    return { project: toProject(data as Row) };
  });

  app.delete('/api/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data, error } = await req.db!.from('projects').delete().eq('id', params.id).select('id');
    if (error) return replyDbError(reply, error);
    if (!data || data.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return reply.code(204).send();
  });

  /**
   * Marks the project as recently touched. Drives "Continue Learning" on the
   * home dashboard (PRD §16), which needs to answer "where was I?".
   */
  app.post('/api/projects/:id/touch', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data, error } = await req
      .db!.from('projects')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', params.id)
      .select('id, last_active_at')
      .single();

    if (error) return replyDbError(reply, error);
    return { ok: true, lastActiveAt: data.last_active_at };
  });
};
