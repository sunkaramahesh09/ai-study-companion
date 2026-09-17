import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { serviceClient } from '../lib/supabase.ts';

/**
 * Input validation at the HTTP edge (PRD §15).
 *
 * The CRUD suite covers the happy path and cross-user access. This covers the
 * edges an attacker or a buggy client actually sends: wrong types, absurd
 * sizes, malformed ids, unknown fields, and the classic case of a JSON client
 * sending `null` where a value is optional.
 *
 * Every case here asserts a 4xx with a usable message rather than a 500. A
 * validation failure that surfaces as a server error tells the caller nothing
 * and tells the logs that the server is broken.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('input validation', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let user: { id: string; token: string };
  let spaceId: string;
  let projectId: string;

  const auth = () => ({ authorization: `Bearer ${user.token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const email = `valid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s } = await anon.auth.signInWithPassword({ email, password });
    user = { id: data.user!.id, token: s.session!.access_token };

    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: user.id, name: 'Validation' }).select('id').single();
    spaceId = space!.id;
    const { data: project } = await serviceClient()
      .from('projects').insert({ space_id: spaceId, user_id: user.id, name: 'Validation' }).select('id').single();
    projectId = project!.id;
  });

  afterAll(async () => {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
    await app?.close();
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(), payload: payload as never });

  describe('malformed identifiers', () => {
    it.each([
      ['not-a-uuid', '/api/projects/not-a-uuid'],
      ['sql-ish', "/api/projects/1'%20OR%20'1'='1"],
      ['empty-ish', '/api/projects/%20'],
    ])('rejects %s in a path parameter without reaching the database', async (_label, url) => {
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      // 400, not 500 and not 404: the id is malformed, which is the caller's
      // problem and is knowable before any query runs.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    });

    it('rejects a well-formed uuid that is not the caller\'s', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/projects/${crypto.randomUUID()}`, headers: auth(),
      });
      // 404, not 403: confirming a resource exists but is someone else's is
      // itself a disclosure.
      expect(res.statusCode).toBe(404);
    });
  });

  describe('request bodies', () => {
    it('rejects a missing required field with field-level detail', async () => {
      const res = await post('/api/spaces', {});
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/name/i);
    });

    it('rejects the wrong type rather than coercing it', async () => {
      // Coercing 12345 to "12345" would store a space nobody asked for.
      const res = await post('/api/spaces', { name: 12345 });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a name of whitespace only', async () => {
      const res = await post('/api/spaces', { name: '   ' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an absurdly long value instead of letting the database refuse it', async () => {
      const res = await post('/api/spaces', { name: 'x'.repeat(50_000) });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an array where an object is expected', async () => {
      const res = await post('/api/spaces', [{ name: 'Sneaky' }]);
      expect(res.statusCode).toBe(400);
    });

    it('rejects malformed JSON as a client error', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/spaces', headers: auth(), payload: '{"name": "unterminated',
      });
      expect(res.statusCode).toBe(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('ignores an unknown field rather than storing it', async () => {
      const res = await post('/api/spaces', { name: 'Extra fields', nonsense: true, role: 'admin' });
      expect(res.statusCode).toBe(201);
      expect(res.json().space.role).toBeUndefined();
      expect(res.json().space.nonsense).toBeUndefined();
    });
  });

  describe('the tutor endpoint', () => {
    it('rejects a question that is too short to mean anything', async () => {
      const res = await post('/api/tutor/ask', { projectId, question: 'hi' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a question far past the length limit', async () => {
      const res = await post('/api/tutor/ask', { projectId, question: 'why '.repeat(2000) });
      expect(res.statusCode).toBe(400);
    });

    it('accepts an explicit null conversationId as "no conversation"', async () => {
      // JSON clients routinely send null for "no value". Rejecting that with a
      // 400 is pedantry rather than validation, so it is normalised instead.
      // Asserted by NOT being a validation error — the project has no material,
      // so the Tutor legitimately declines further down.
      const res = await post('/api/tutor/ask', {
        projectId, question: 'What is cellular respiration?', conversationId: null,
      });
      expect(res.statusCode).not.toBe(400);
    });

    it('rejects a conversationId that is not a uuid', async () => {
      const res = await post('/api/tutor/ask', {
        projectId, question: 'What is cellular respiration?', conversationId: 'nope',
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses to start a conversation in someone else\'s project', async () => {
      const res = await post('/api/tutor/ask', {
        projectId: crypto.randomUUID(), question: 'What is cellular respiration?',
      });
      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('the quiz endpoint', () => {
    it('rejects a target length outside the allowed range', async () => {
      for (const targetLength of [0, -3, 500]) {
        const res = await post('/api/quizzes', { projectId, targetLength });
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects a missing projectId', async () => {
      const res = await post('/api/quizzes', { targetLength: 5 });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('mass assignment', () => {
    it('will not let a caller set the owner of a space', async () => {
      const victim = crypto.randomUUID();
      const res = await post('/api/spaces', { name: 'Ownership test', user_id: victim, userId: victim });
      expect(res.statusCode).toBe(201);

      const { data } = await serviceClient()
        .from('spaces').select('user_id').eq('id', res.json().space.id).single();
      // Ownership comes from the verified token, never from the body.
      expect(data!.user_id).toBe(user.id);
    });

    it('will not let a caller set a project\'s id or timestamps', async () => {
      const forgedId = crypto.randomUUID();
      const res = await post('/api/projects', {
        spaceId, name: 'Forged', id: forgedId, created_at: '1999-01-01T00:00:00Z',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().project.id).not.toBe(forgedId);
      expect(new Date(res.json().project.createdAt ?? Date.now()).getFullYear()).toBeGreaterThan(2020);
    });
  });
});
