import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * Authentication and the admin gate, exercised through real HTTP requests
 * against the real auth provider. `app.inject()` runs the full Fastify
 * lifecycle — plugins, preHandlers, serialization — so what is tested here is
 * the path a browser actually takes.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('authentication', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let plainUser: { id: string; token: string };
  let adminUser: { id: string; token: string };

  async function makeUser(label: string, role: 'user' | 'admin') {
    const email = `auth-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    const id = data.user!.id;

    if (role === 'admin') {
      // Promotion is a service-role operation by design — a user cannot do
      // this to themselves (see the escalation test in isolation.test.ts).
      const { error: roleErr } = await admin.from('profiles').update({ role: 'admin' }).eq('id', id);
      if (roleErr) throw new Error(`promote failed: ${roleErr.message}`);
    }

    const anon = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: session, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr) throw new Error(`signIn failed: ${signInErr.message}`);

    return { id, token: session.session!.access_token };
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    [plainUser, adminUser] = await Promise.all([makeUser('user', 'user'), makeUser('admin', 'admin')]);
  });

  afterAll(async () => {
    for (const u of [plainUser, adminUser]) {
      if (u?.id) await admin.auth.admin.deleteUser(u.id);
    }
    await app?.close();
  });

  it('serves /health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api' });
  });

  it('rejects /api/me with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: plainUser.token },   // missing "Bearer "
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid token and returns the caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${plainUser.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: plainUser.id, role: 'user' });
  });

  it('gives a non-admin 403 on an admin route, not 401', async () => {
    // The distinction matters: the caller IS authenticated, just not permitted.
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { authorization: `Bearer ${plainUser.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets an admin through the admin route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { authorization: `Bearer ${adminUser.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, role: 'admin' });
  });

  it('reads the role from the database, not from the presented token', async () => {
    // Demoting in the database must take effect on the very next request even
    // though the user still holds the same, still-valid JWT. If role came from
    // a token claim, this would keep returning 200.
    await admin.from('profiles').update({ role: 'user' }).eq('id', adminUser.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { authorization: `Bearer ${adminUser.token}` },
    });
    expect(res.statusCode).toBe(403);

    await admin.from('profiles').update({ role: 'admin' }).eq('id', adminUser.id);
  });

  it('creates a profile row automatically on signup', async () => {
    const { data } = await admin.from('profiles').select('id, role').eq('id', plainUser.id).single();
    expect(data).toMatchObject({ id: plainUser.id, role: 'user' });
  });
});
