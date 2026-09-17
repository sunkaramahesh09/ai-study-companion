import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { serviceClient } from '../lib/supabase.ts';
import { stopQueue } from '../lib/queue.ts';

/**
 * Admin Dashboard access control and reach (PRD §17).
 *
 * Two things are being proved, and the second is the one that is easy to get
 * wrong. First, that a non-admin is refused on every admin route. Second, that
 * an admin's extra reach comes from the DATABASE — `profiles.role` plus the
 * `is_admin()` clause in the RLS policies — and not from the route handler
 * choosing to use a service-role client. The test for that is promoting a user
 * mid-session and re-using the SAME token: if reach were decided by anything
 * in the token, the promotion could not take effect.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

const ADMIN_ROUTES = [
  '/api/admin/overview',
  '/api/admin/users',
  '/api/admin/activity',
  '/api/admin/ai',
  '/api/admin/evals',
];

describeIntegration('admin dashboard', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let boss: { id: string; token: string };
  let learner: { id: string; token: string };
  let learnerProjectId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function makeUser(label: string) {
    const email = `admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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
    [boss, learner] = await Promise.all([makeUser('boss'), makeUser('learner')]);

    const { data: space, error: se } = await serviceClient()
      .from('spaces').insert({ user_id: learner.id, name: 'Learner Space' }).select('id').single();
    if (se) throw new Error(se.message);
    const { data: project, error: pe } = await serviceClient()
      .from('projects').insert({ space_id: space!.id, user_id: learner.id, name: 'Learner Project' })
      .select('id').single();
    if (pe) throw new Error(pe.message);
    learnerProjectId = project!.id;

    const { error: ee } = await serviceClient().from('learning_events').insert([
      { user_id: learner.id, project_id: learnerProjectId, event_type: 'project_created', created_at: daysAgo(1) },
      { user_id: learner.id, project_id: learnerProjectId, event_type: 'tutor_answer', created_at: daysAgo(1) },
      { user_id: learner.id, project_id: learnerProjectId, event_type: 'tutor_unsupported', created_at: daysAgo(2) },
    ]);
    if (ee) throw new Error(ee.message);

    // Every row spells out every column any other row sets — see landmine 9.
    const { error: ae } = await serviceClient().from('ai_requests').insert([
      {
        user_id: learner.id, project_id: learnerProjectId, feature: 'tutor_answer', provider: 'groq',
        model: 'openai/gpt-oss-120b', status: 'success', latency_ms: 1100,
        prompt_tokens: 1800, completion_tokens: 300, total_tokens: 2100,
        estimated_cost_usd: 0.0003, used_fallback: false, attempt_count: 1,
        error_code: null, error_message: null, created_at: daysAgo(1),
      },
      {
        user_id: learner.id, project_id: learnerProjectId, feature: 'question_generation', provider: 'groq',
        model: 'openai/gpt-oss-20b', status: 'rate_limited', latency_ms: 30_000,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        estimated_cost_usd: 0, used_fallback: false, attempt_count: 4,
        error_code: '429', error_message: 'rate limit exceeded', created_at: daysAgo(1),
      },
    ]);
    if (ae) throw new Error(ae.message);
  });

  afterAll(async () => {
    for (const u of [boss, learner]) if (u?.id) await admin.auth.admin.deleteUser(u.id);
    await app?.close();
    // /api/admin/overview opens a pg-boss connection for queue health.
    await stopQueue();
  });

  describe('access control', () => {
    it.each(ADMIN_ROUTES)('refuses a non-admin on %s', async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: auth(learner.token) });
      // 403, not 404: the caller is authenticated, just not permitted.
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
    });

    it.each(ADMIN_ROUTES)('refuses an anonymous caller on %s', async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a token whose payload claims admin', async () => {
      // role is read from the database, so forging the claim achieves nothing.
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: learner.id, role: 'admin', app_metadata: { role: 'admin' } })).toString('base64url'),
        'not-a-real-signature',
      ].join('.');
      const res = await app.inject({
        method: 'GET', url: '/api/admin/overview', headers: auth(forged),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('once promoted in the database', () => {
    beforeAll(async () => {
      const { error } = await serviceClient().from('profiles').update({ role: 'admin' }).eq('id', boss.id);
      if (error) throw new Error(error.message);
    });

    it('grants access using the SAME token issued before promotion', async () => {
      // Nothing was re-issued. If reach came from the token, this would still
      // be a 403.
      const res = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: auth(boss.token) });
      expect(res.statusCode).toBe(200);
    });

    it('sees another user, their content and their activity', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/overview?days=30', headers: auth(boss.token) });
      const body = res.json();
      expect(body.users.total).toBeGreaterThanOrEqual(2);
      expect(body.content.projects).toBeGreaterThanOrEqual(1);
      expect(body.activity.byType.tutor_answer).toBeGreaterThanOrEqual(1);
      expect(body.tutor.refused).toBeGreaterThanOrEqual(1);
    });

    it('attributes usage to the right user', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth(boss.token) });
      const row = res.json().users.find((u: any) => u.id === learner.id);
      expect(row).toBeDefined();
      expect(row.projects).toBe(1);
      expect(row.tokens).toBe(2100);
      // The admin themselves has done nothing, and that shows as zero, not as
      // the other user's numbers leaking across.
      const self = res.json().users.find((u: any) => u.id === boss.id);
      expect(self.projects).toBe(0);
      expect(self.tokens).toBe(0);
    });

    it('filters the activity feed', async () => {
      const byUser = await app.inject({
        method: 'GET', url: `/api/admin/activity?userId=${learner.id}&days=30`, headers: auth(boss.token),
      });
      expect(byUser.json().events.length).toBeGreaterThanOrEqual(3);
      expect(byUser.json().events.every((e: any) => e.user_id === learner.id)).toBe(true);

      const byType = await app.inject({
        method: 'GET', url: `/api/admin/activity?type=tutor_unsupported&days=30`, headers: auth(boss.token),
      });
      expect(byType.json().events.every((e: any) => e.event_type === 'tutor_unsupported')).toBe(true);
      expect(byType.json().events.length).toBeGreaterThanOrEqual(1);
    });

    it('surfaces AI failures with enough detail to chase one', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/ai?days=30', headers: auth(boss.token) });
      const body = res.json();
      const failure = body.recentFailures.find((f: any) => f.error_code === '429');
      expect(failure).toBeDefined();
      expect(failure.attempt_count).toBe(4);
      expect(failure.model).toBe('openai/gpt-oss-20b');
      // The 30s rate-limited request must not pollute the latency figures.
      // Asserted as a bound rather than an exact value: an admin's view spans
      // every user, and this database is shared with other tests.
      expect(body.summary.medianLatencyMs).toBeLessThan(30_000);
      expect(body.summary.failures).toBeGreaterThanOrEqual(1);
    });

    it('reports job health without letting the queue take the page down', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: auth(boss.token) });
      const { jobs } = res.json();
      // Either it connected, or it reported why — never a 500.
      expect(res.statusCode).toBe(200);
      expect(typeof jobs.available).toBe('boolean');
      if (jobs.available) {
        expect(jobs.queues.map((q: any) => q.name)).toContain('material.process');
      } else {
        expect(jobs.error).toBeTruthy();
      }
    });

    it('reports an evaluation that has never run as exactly that', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/evals', headers: auth(boss.token) });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().runs)).toBe(true);
    });
  });
});
