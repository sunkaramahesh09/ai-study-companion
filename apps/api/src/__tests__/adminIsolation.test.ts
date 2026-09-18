import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * An admin is an admin on `/api/admin/*` and a learner everywhere else.
 *
 * Every RLS select policy reads `user_id = auth.uid() OR public.is_admin()`,
 * so for an admin RLS is not a filter at all. The learner routes relied on it
 * alone (D-012), which meant an admin's own Home, Spaces and Analytics
 * returned other people's rows — reported from production, where a brand-new
 * admin account opened on somebody else's space and their 20 answered
 * questions. See D-073.
 *
 * These assertions fail against the pre-fix code, which is the only reason to
 * write them.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('an admin does not see other users through the learner API', () => {
  const service = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let learner: { id: string; token: string };
  let admin: { id: string; token: string };
  let learnerSpaceId: string;
  let learnerProjectId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function makeUser(label: string) {
    const email = `iso-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email, password });
    if (e2) throw new Error(e2.message);
    return { id: data.user!.id, token: s.session!.access_token };
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    [learner, admin] = await Promise.all([makeUser('learner'), makeUser('admin')]);

    // Promotion happens in the database, exactly as scripts/create-admin.mjs
    // does it — the role is never a token claim (D-053).
    const { error } = await service.from('profiles').update({ role: 'admin' }).eq('id', admin.id);
    if (error) throw new Error(error.message);

    const space = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: auth(learner.token),
      payload: { name: 'Learner private space' },
    });
    learnerSpaceId = space.json().space.id;

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: auth(learner.token),
      payload: { spaceId: learnerSpaceId, name: 'Learner private project' },
    });
    learnerProjectId = project.json().project.id;
  });

  afterAll(async () => {
    for (const u of [learner, admin]) if (u?.id) await service.auth.admin.deleteUser(u.id);
    await app?.close();
  });

  it('confirms the admin really is an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/ping', headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
  });

  it('does not list another user\'s spaces on /api/spaces', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().spaces.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(learnerSpaceId);
    expect(res.json().spaces).toHaveLength(0);
  });

  it('does not list another user\'s projects on /api/projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().projects.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(learnerProjectId);
  });

  it('does not open another user\'s space by id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/spaces/${learnerSpaceId}`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).not.toBe(200);
  });

  it('does not open another user\'s project dashboard by id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${learnerProjectId}`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).not.toBe(200);
  });

  it('does not count another user\'s spaces in global analytics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics?days=30', headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.spaces).toBe(0);
  });

  it('does not start a quiz in another user\'s project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/quizzes',
      headers: auth(admin.token),
      payload: { projectId: learnerProjectId, targetLength: 5 },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('does not ask the Tutor inside another user\'s project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tutor/ask',
      headers: auth(admin.token),
      payload: { projectId: learnerProjectId, question: 'What is in this project?' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('still lets the learner reach their own data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers: auth(learner.token) });
    expect(res.json().spaces.map((s: { id: string }) => s.id)).toContain(learnerSpaceId);
  });

  it('gives the admin the platform view on the admin routes', async () => {
    // The point is not that admins see less — it is that they see everything
    // HERE and nothing extra anywhere else.
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const emails = res.json().users.map((u: { email: string }) => u.email);
    expect(emails.length).toBeGreaterThan(1);
  });
});
