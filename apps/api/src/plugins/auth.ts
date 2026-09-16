import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { SupabaseClient } from '@supabase/supabase-js';
import { userClient } from '../lib/supabase.ts';
import { unsafeDecodeSubject } from '../lib/jwt.ts';

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: 'user' | 'admin';
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    /** RLS-scoped Supabase client bound to this request's caller. */
    db?: SupabaseClient;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  /**
   * Verifies the caller and attaches both the user and an RLS-scoped client.
   *
   * One database round trip does all of it. The token's `sub` claim is decoded
   * locally to choose which profile row to request, then that row is fetched
   * through the caller's own RLS-scoped client. Postgres validates the
   * signature and expiry before returning anything, so:
   *
   *   - a forged or expired token returns no row  -> 401
   *   - the row that comes back proves the token is genuine
   *   - `role` arrives from the database in the same trip
   *
   * The earlier version called auth.getUser() and then read the profile with
   * the service key: two sequential network calls (~300ms) on every request,
   * and the service role — which bypasses RLS — sitting in the hot path of
   * ordinary requests. This is faster and keeps that key out of request
   * handling entirely.
   */
  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token.' });
    }

    const subject = unsafeDecodeSubject(token);
    if (!subject) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Malformed token.' });
    }

    const db = userClient(token);
    // .eq('id', subject) is required, not incidental: the profiles_select
    // policy also matches when the caller is an admin, so an unfiltered
    // .single() would return every profile and fail for admins.
    const { data: profile, error } = await db
      .from('profiles')
      .select('id, email, role')
      .eq('id', subject)
      .single();

    if (error || !profile) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token.' });
    }

    // role comes from the database, never from a client-presented claim, so it
    // cannot be forged by editing a JWT payload.
    req.user = {
      id: profile.id,
      email: profile.email ?? '',
      role: profile.role === 'admin' ? 'admin' : 'user',
    };
    req.db = db;
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (reply.sent) return;
    if (req.user?.role !== 'admin') {
      // 403, not 404: the caller is authenticated, just not permitted.
      return reply.code(403).send({ error: 'forbidden', message: 'Administrator access required.' });
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
