import { spaceCreateSchema, spaceUpdateSchema, uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { recordEvent } from '../lib/events.ts';
import { parseOrReply, replyDbError } from '../lib/errors.ts';

const SELECT = 'id, name, description, color, icon, created_at, updated_at';

type Row = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  projects?: { count: number }[];
};

const toSpace = (r: Row) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  color: r.color,
  icon: r.icon,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  projectCount: r.projects?.[0]?.count ?? 0,
});

/**
 * Space routes.
 *
 * Every handler queries through `req.db`, the RLS-scoped client bound to the
 * caller's JWT, so isolation is enforced by Postgres rather than by a `where`
 * clause a handler could forget (D-012). None of these queries filter on
 * user_id explicitly — that is the point.
 */
export const spaceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/spaces', { preHandler: app.requireAuth }, async (req, reply) => {
    const { data, error } = await req
      .db!.from('spaces')
      // Aggregated count avoids an N+1 round trip per space on the dashboard.
      .select(`${SELECT}, projects(count)`)
      .order('created_at', { ascending: false });

    if (error) return replyDbError(reply, error);
    return { spaces: (data as Row[]).map(toSpace) };
  });

  app.get('/api/spaces/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data, error } = await req
      .db!.from('spaces')
      .select(`${SELECT}, projects(count)`)
      .eq('id', params.id)
      .single();

    if (error) return replyDbError(reply, error);
    return { space: toSpace(data as Row) };
  });

  app.post('/api/spaces', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parseOrReply(spaceCreateSchema, req.body, reply);
    if (!body) return;

    const { data, error } = await req
      .db!.from('spaces')
      .insert({
        // From the verified token, never from the request body — a client that
        // could choose user_id could write into someone else's account.
        user_id: req.user!.id,
        name: body.name,
        description: body.description ?? null,
        color: body.color ?? null,
        icon: body.icon ?? null,
      })
      .select(SELECT)
      .single();

    if (error) return replyDbError(reply, error);

    const space = toSpace(data as Row);
    await recordEvent({
      userId: req.user!.id,
      type: 'space_created',
      spaceId: space.id,
      payload: { name: space.name },
      idempotencyKey: `space_created:${space.id}`,
    });

    return reply.code(201).send({ space });
  });

  app.patch('/api/spaces/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const body = parseOrReply(spaceUpdateSchema, req.body, reply);
    if (!body) return;

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.color !== undefined) patch.color = body.color;
    if (body.icon !== undefined) patch.icon = body.icon;

    const { data, error } = await req
      .db!.from('spaces')
      .update(patch)
      .eq('id', params.id)
      .select(SELECT)
      .single();

    if (error) return replyDbError(reply, error);
    return { space: toSpace(data as Row) };
  });

  app.delete('/api/spaces/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    // Select back the deleted row: RLS makes a non-owner's delete affect zero
    // rows silently, and reporting 204 for that would be a lie.
    const { data, error } = await req
      .db!.from('spaces')
      .delete()
      .eq('id', params.id)
      .select('id');

    if (error) return replyDbError(reply, error);
    if (!data || data.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return reply.code(204).send();
  });
};
