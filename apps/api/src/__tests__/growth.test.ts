import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * The growth endpoint through real HTTP.
 *
 * `analyseGrowth` is unit-tested as a pure function; this proves the route
 * feeds it the right evidence — correct ordering, the caller's own project
 * only, and untested concepts reported as unknown rather than as 50%.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('growth API', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let projectId: string;
  const conceptIds: Record<string, string> = {};

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

  async function makeUser(label: string) {
    const email = `growth-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email, password });
    if (e2) throw new Error(e2.message);
    return { id: data.user!.id, token: s.session!.access_token };
  }

  /** Seeds a concept with a mastery score and a history trail, via service role. */
  async function seedConcept(
    name: string,
    opts: { score: number; evidence: number; history: { score: number; minsAgo: number }[] },
  ) {
    const { data: concept, error } = await admin
      .from('concepts')
      .insert({ project_id: projectId, user_id: alice.id, name })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    const conceptId = concept!.id as string;
    conceptIds[name] = conceptId;

    if (opts.evidence > 0) {
      const { error: e2 } = await admin.from('concept_mastery').insert({
        concept_id: conceptId,
        project_id: projectId,
        user_id: alice.id,
        score: opts.score,
        evidence_count: opts.evidence,
        last_evidence_at: ago(opts.history.at(-1)?.minsAgo ?? 10),
      });
      if (e2) throw new Error(e2.message);
    }

    if (opts.history.length > 0) {
      const { error: e3 } = await admin.from('mastery_history').insert(
        opts.history.map((h, i) => ({
          concept_id: conceptId,
          project_id: projectId,
          user_id: alice.id,
          score_before: i === 0 ? 0.5 : opts.history[i - 1]!.score,
          score_after: h.score,
          reason: 'quiz_answer',
          created_at: ago(h.minsAgo),
        })),
      );
      if (e3) throw new Error(e3.message);
    }
    return conceptId;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    [alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')]);

    const space = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(alice.token),
      payload: { name: 'Growth Space' },
    });
    const project = await app.inject({
      method: 'POST', url: '/api/projects', headers: auth(alice.token),
      payload: { spaceId: space.json().space.id, name: 'Growth Project' },
    });
    projectId = project.json().project.id;

    // Deliberately inserted newest-first so the route cannot pass by accident
    // of insertion order.
    await seedConcept('Backpropagation', {
      score: 0.82, evidence: 5,
      history: [{ score: 0.5, minsAgo: 50 }, { score: 0.66, minsAgo: 30 }, { score: 0.82, minsAgo: 10 }],
    });
    await seedConcept('Regularisation', {
      score: 0.28, evidence: 4,
      history: [{ score: 0.44, minsAgo: 40 }, { score: 0.35, minsAgo: 25 }, { score: 0.28, minsAgo: 8 }],
    });
    await seedConcept('Convolution', {
      score: 0.71, evidence: 6,
      history: [{ score: 0.7, minsAgo: 45 }, { score: 0.72, minsAgo: 20 }, { score: 0.71, minsAgo: 6 }],
    });
    await seedConcept('Attention', { score: 0, evidence: 0, history: [] });
  });

  afterAll(async () => {
    for (const u of [alice, bob]) if (u?.id) await admin.auth.admin.deleteUser(u.id);
    await app?.close();
  });

  it('classifies each concept from its mastery history', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth`, headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.json().concepts.map((c: any) => [c.name, c]));

    expect(byName['Backpropagation'].growth.trend).toBe('improving');
    expect(byName['Regularisation'].growth.trend).toBe('needs_attention');
    expect(byName['Convolution'].growth.trend).toBe('stable');
    expect(byName['Attention'].growth.trend).toBe('new');
  });

  it('leads with what needs work', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth`, headers: auth(alice.token) });
    const order = res.json().concepts.map((c: any) => c.name);
    expect(order[0]).toBe('Regularisation');
    expect(order.at(-1)).toBe('Backpropagation');
  });

  it('reads history chronologically regardless of row order', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth`, headers: auth(alice.token) });
    const backprop = res.json().concepts.find((c: any) => c.name === 'Backpropagation');
    // Oldest first: a reversed window would report a decline here.
    expect(backprop.history.map((h: any) => h.score)).toEqual([0.5, 0.66, 0.82]);
    expect(backprop.growth.from).toBe(0.5);
    expect(backprop.growth.to).toBe(0.82);
    expect(backprop.growth.delta).toBeGreaterThan(0);
  });

  it('averages mastery over assessed concepts only', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth`, headers: auth(alice.token) });
    const { summary } = res.json();
    expect(summary.total).toBe(4);
    expect(summary.assessed).toBe(3);
    // Including the untested concept's 0.5 prior would give 0.5775.
    expect(summary.averageMastery).toBeCloseTo((0.82 + 0.28 + 0.71) / 3, 3);
    expect(summary.needsAttention).toBe(1);
    expect(summary.improving).toBe(1);
    expect(summary.stable).toBe(1);
  });

  it('refuses another user the project', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth`, headers: auth(bob.token) });
    expect(res.statusCode).toBe(404);
  });

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/growth` });
    expect(res.statusCode).toBe(401);
  });

  it('will not let another user resolve a recommendation', async () => {
    const { data, error } = await admin
      .from('recommendations')
      .insert({
        project_id: projectId, user_id: alice.id, concept_id: conceptIds['Regularisation'],
        trigger_reason: 'weak_concept', title: 'Revisit regularisation',
        body: 'Your last three answers moved the wrong way.', action_type: 'take_quiz',
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);

    const stolen = await app.inject({
      method: 'PATCH', url: `/api/recommendations/${data!.id}`, headers: auth(bob.token),
      payload: { status: 'dismissed' },
    });
    expect(stolen.statusCode).toBe(404);

    const mine = await app.inject({
      method: 'PATCH', url: `/api/recommendations/${data!.id}`, headers: auth(alice.token),
      payload: { status: 'dismissed' },
    });
    expect(mine.statusCode).toBe(200);

    // Dismissed recommendations leave the active list.
    const list = await app.inject({
      method: 'GET', url: `/api/projects/${projectId}/recommendations`, headers: auth(alice.token),
    });
    expect(list.json().recommendations).toHaveLength(0);
  });

  it('rejects a status it does not recognise', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/recommendations/${crypto.randomUUID()}`, headers: auth(alice.token),
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(400);
  });
});
