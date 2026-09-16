import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * Spaces and Projects through real HTTP, including cross-user access via the
 * routes themselves. The RLS suite proves the database refuses; this proves the
 * API surface refuses too, which is what an attacker actually touches.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('spaces and projects API', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let spaceId: string;
  let projectId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function makeUser(label: string) {
    const email = `crud-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email, password });
    if (e2) throw new Error(e2.message);
    return { id: data.user!.id, token: s.session!.access_token };
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    [alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')]);
  });

  afterAll(async () => {
    for (const u of [alice, bob]) if (u?.id) await admin.auth.admin.deleteUser(u.id);
    await app?.close();
  });

  it('creates a space', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(alice.token),
      payload: { name: 'Machine Learning', description: 'Core ML concepts', color: '#6d8cff' },
    });
    expect(res.statusCode).toBe(201);
    spaceId = res.json().space.id;
    expect(res.json().space.name).toBe('Machine Learning');
  });

  it('rejects an invalid payload with field detail', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(alice.token),
      payload: { name: '', color: 'blue' },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().fields.map((f: { path: string }) => f.path);
    expect(paths).toContain('name');
    expect(paths).toContain('color');
  });

  it('trims whitespace rather than storing a padded name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(alice.token),
      payload: { name: '   Padded   ' },
    });
    expect(res.json().space.name).toBe('Padded');
    await app.inject({ method: 'DELETE', url: `/api/spaces/${res.json().space.id}`, headers: auth(alice.token) });
  });

  it('requires auth on every route', async () => {
    for (const [method, url] of [['GET', '/api/spaces'], ['POST', '/api/spaces'], ['GET', '/api/projects']] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it('creates a project inside the space', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/projects', headers: auth(alice.token),
      payload: { spaceId, name: 'Gradient Descent', goal: 'Understand optimisation well enough to explain it' },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().project.id;
    expect(res.json().project.goal).toContain('optimisation');
  });

  it('returns a dashboard payload in one request', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project.id).toBe(projectId);
    // Shape is fixed now so the frontend needs no rework when later tasks
    // start producing rows.
    expect(body).toHaveProperty('materials');
    expect(body).toHaveProperty('mastery');
    expect(body).toHaveProperty('recommendations');
    expect(body).toHaveProperty('recentActivity');
  });

  it('records a project_created learning event', async () => {
    const { data } = await admin.from('learning_events').select('event_type, project_id')
      .eq('project_id', projectId).eq('event_type', 'project_created');
    expect(data).toHaveLength(1);
  });

  it('counts projects per space without an N+1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers: auth(alice.token) });
    const space = res.json().spaces.find((s: { id: string }) => s.id === spaceId);
    expect(space.projectCount).toBe(1);
  });

  it('filters projects by space', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects?spaceId=${spaceId}`, headers: auth(alice.token) });
    expect(res.json().projects).toHaveLength(1);
  });

  it('updates a project', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}`, headers: auth(alice.token),
      payload: { goal: 'Revised goal' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.goal).toBe('Revised goal');
  });

  it('rejects an empty update', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}`, headers: auth(alice.token), payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // --- isolation, through the API surface ---------------------------------

  it("does not list Alice's spaces for Bob", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces', headers: auth(bob.token) });
    expect(res.json().spaces).toEqual([]);
  });

  it("404s, not 403, when Bob requests Alice's project by id", async () => {
    // Confirming an id exists but belongs to someone else is itself a
    // disclosure, so an RLS-filtered read is reported as not found.
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: auth(bob.token) });
    expect(res.statusCode).toBe(404);
  });

  it("refuses Bob creating a project in Alice's space", async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/projects', headers: auth(bob.token),
      payload: { spaceId, name: 'intrusion' },
    });
    expect([403, 404, 500]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(201);
  });

  it("refuses Bob updating Alice's project", async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}`, headers: auth(bob.token),
      payload: { name: 'hijacked' },
    });
    expect(res.statusCode).toBe(404);
    const check = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: auth(alice.token) });
    expect(check.json().project.name).toBe('Gradient Descent');
  });

  it("refuses Bob deleting Alice's project", async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: auth(bob.token) });
    expect(res.statusCode).toBe(404);
    const check = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: auth(alice.token) });
    expect(check.statusCode).toBe(200);
  });

  it('cannot forge ownership by sending a user_id in the body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(bob.token),
      payload: { name: 'forged', user_id: alice.id },
    });
    expect(res.statusCode).toBe(201);
    // The body field is ignored: ownership comes from the verified token.
    const { data } = await admin.from('spaces').select('user_id').eq('id', res.json().space.id).single();
    expect(data!.user_id).toBe(bob.id);
  });

  it('deletes a project, then the space', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: auth(alice.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/spaces/${spaceId}`, headers: auth(alice.token) })).statusCode).toBe(204);
  });

  it('404s when deleting something already gone', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${spaceId}`, headers: auth(alice.token) });
    expect(res.statusCode).toBe(404);
  });
});
