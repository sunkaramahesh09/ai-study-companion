import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { serviceClient } from '../lib/supabase.ts';

/**
 * Project and Global analytics through real HTTP.
 *
 * The arithmetic is unit-tested as pure functions. What this proves is the
 * part that can only break in integration: that the queries feeding it are
 * scoped to the caller, honour the requested window, and exclude rows that
 * would quietly distort a number a learner is shown.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('analytics API', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let spaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let conceptId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function makeUser(label: string) {
    const email = `analytics-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
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

    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: alice.id, name: 'Analytics Space' }).select('id').single();
    spaceId = space!.id;

    const { data: project } = await serviceClient()
      .from('projects').insert({ space_id: spaceId, user_id: alice.id, name: 'Tracked' }).select('id').single();
    projectId = project!.id;

    const { data: other } = await serviceClient()
      .from('projects').insert({ space_id: spaceId, user_id: alice.id, name: 'Untracked' }).select('id').single();
    otherProjectId = other!.id;

    const { data: concept } = await serviceClient()
      .from('concepts').insert({ project_id: projectId, user_id: alice.id, name: 'Osmosis' }).select('id').single();
    conceptId = concept!.id;

    await serviceClient().from('concept_mastery').insert({
      concept_id: conceptId, project_id: projectId, user_id: alice.id,
      score: 0.7, evidence_count: 4, last_evidence_at: daysAgo(1),
    });

    const evIns = await serviceClient().from('learning_events').insert([
      { user_id: alice.id, project_id: projectId, space_id: spaceId, event_type: 'quiz_started', created_at: daysAgo(1) },
      { user_id: alice.id, project_id: projectId, space_id: spaceId, event_type: 'tutor_answer', created_at: daysAgo(1) },
      { user_id: alice.id, project_id: projectId, space_id: spaceId, event_type: 'tutor_answer', created_at: daysAgo(2) },
      { user_id: alice.id, project_id: projectId, space_id: spaceId, event_type: 'tutor_unsupported', created_at: daysAgo(2) },
      // Outside a 7-day window, inside a 30-day one.
      { user_id: alice.id, project_id: projectId, space_id: spaceId, event_type: 'quiz_completed', created_at: daysAgo(20) },
      // A different project of the same user: global counts it, project does not.
      { user_id: alice.id, project_id: otherProjectId, space_id: spaceId, event_type: 'project_created', created_at: daysAgo(1) },
    ]);
    if (evIns.error) throw new Error(`events: ${evIns.error.message}`);

    const { data: attempt } = await serviceClient().from('quiz_attempts').insert({
      project_id: projectId, user_id: alice.id, status: 'completed',
      target_length: 3, questions_answered: 3, correct_count: 2, score: 0.6667,
      started_at: daysAgo(1), completed_at: daysAgo(1),
    }).select('id').single();

    const { data: abandoned } = await serviceClient().from('quiz_attempts').insert({
      project_id: projectId, user_id: alice.id, status: 'abandoned',
      target_length: 5, questions_answered: 1, correct_count: 0,
      started_at: daysAgo(3),
    }).select('id').single();

    const qIns = await serviceClient().from('quiz_questions').insert([
      {
        attempt_id: attempt!.id, project_id: projectId, user_id: alice.id, concept_id: conceptId,
        position: 0, question_type: 'mcq', difficulty: 2, prompt: 'Q1', options: ['a', 'b'],
        correct_index: 0, user_answer: '0', is_correct: true, score: 1, answered_at: daysAgo(1),
      },
      {
        attempt_id: attempt!.id, project_id: projectId, user_id: alice.id, concept_id: conceptId,
        position: 1, question_type: 'mcq', difficulty: 4, prompt: 'Q2', options: ['a', 'b'],
        correct_index: 1, user_answer: '0', is_correct: false, score: 0, answered_at: daysAgo(1),
      },
      {
        attempt_id: attempt!.id, project_id: projectId, user_id: alice.id, concept_id: conceptId,
        position: 2, question_type: 'open', difficulty: 3, prompt: 'Q3',
        user_answer: 'something', is_correct: true, score: 0.8, answered_at: daysAgo(1),
      },
      // Never answered — the learner closed the tab. Must not count as wrong.
      {
        attempt_id: abandoned!.id, project_id: projectId, user_id: alice.id, concept_id: conceptId,
        position: 0, question_type: 'mcq', difficulty: 5, prompt: 'Q4', options: ['a', 'b'],
        correct_index: 0,
      },
    ]);
    if (qIns.error) throw new Error(`questions: ${qIns.error.message}`);

    // Every row spells out EVERY column any other row sets. A PostgREST
    // multi-row insert unions the keys across rows and sends an explicit NULL
    // for the ones a given row omits, so a NOT NULL column with a default
    // fails — and fails for the whole batch. See landmine 9.
    const aiIns = await serviceClient().from('ai_requests').insert([
      {
        user_id: alice.id, project_id: projectId, feature: 'tutor_answer', provider: 'groq',
        model: 'openai/gpt-oss-120b', status: 'success', latency_ms: 1200,
        prompt_tokens: 2000, completion_tokens: 400, total_tokens: 2400,
        estimated_cost_usd: 0.0004, used_fallback: false, created_at: daysAgo(1),
      },
      {
        user_id: alice.id, project_id: projectId, feature: 'question_generation', provider: 'groq',
        model: 'openai/gpt-oss-20b', status: 'success', latency_ms: 400,
        prompt_tokens: 500, completion_tokens: 100, total_tokens: 600,
        estimated_cost_usd: 0.00005, used_fallback: true, created_at: daysAgo(1),
      },
      {
        user_id: alice.id, project_id: projectId, feature: 'tutor_answer', provider: 'groq',
        model: 'openai/gpt-oss-120b', status: 'rate_limited', latency_ms: 45_000,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        estimated_cost_usd: 0, used_fallback: false, created_at: daysAgo(2),
      },
    ]);
    if (aiIns.error) throw new Error(`ai_requests: ${aiIns.error.message}`);
  });

  afterAll(async () => {
    for (const u of [alice, bob]) if (u?.id) await admin.auth.admin.deleteUser(u.id);
    await app?.close();
  });

  const projectAnalytics = (token: string, days?: number) =>
    app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/analytics${days ? `?days=${days}` : ''}`,
      headers: auth(token),
    });

  it('returns a zero-filled daily series ending today', async () => {
    const res = await projectAnalytics(alice.token, 7);
    expect(res.statusCode).toBe(200);
    const { activity, window } = res.json();
    expect(window.days).toBe(7);
    expect(activity.buckets).toHaveLength(7);
    expect(activity.buckets.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('honours the requested window', async () => {
    // The 20-day-old quiz_completed is outside 7 days and inside 30.
    const week = (await projectAnalytics(alice.token, 7)).json();
    const month = (await projectAnalytics(alice.token, 30)).json();
    expect(week.activity.byType.quiz_completed).toBeUndefined();
    expect(month.activity.byType.quiz_completed).toBe(1);
  });

  it('clamps an absurd window instead of rejecting it', async () => {
    const res = await projectAnalytics(alice.token, 9999);
    expect(res.statusCode).toBe(200);
    expect(res.json().window.days).toBe(30);
  });

  it('scopes project analytics to that project alone', async () => {
    const res = await projectAnalytics(alice.token, 30);
    // project_created belongs to the sibling project.
    expect(res.json().activity.byType.project_created).toBeUndefined();
  });

  it('excludes unanswered questions from accuracy', async () => {
    const res = await projectAnalytics(alice.token, 30);
    const { assessment } = res.json();
    expect(assessment.answered).toBe(3);
    expect(assessment.correct).toBe(2);
    expect(assessment.byType.mcq.answered).toBe(2);
    expect(assessment.byType.open.answered).toBe(1);
  });

  it('does not average an abandoned attempt in as a zero', async () => {
    // Walking away from a quiz is not the same as failing it.
    const { assessment } = (await projectAnalytics(alice.token, 30)).json();
    expect(assessment.attempts.total).toBe(2);
    expect(assessment.attempts.abandoned).toBe(1);
    expect(assessment.attempts.averageScore).toBeCloseTo(0.6667, 3);
  });

  it('reports the Tutor refusal rate as a quality signal', async () => {
    const { tutor } = (await projectAnalytics(alice.token, 30)).json();
    expect(tutor.answered).toBe(2);
    expect(tutor.refused).toBe(1);
    expect(tutor.rate).toBeCloseTo(0.6667, 3);
  });

  it('summarises AI usage with latency over successes only', async () => {
    const { ai } = (await projectAnalytics(alice.token, 30)).json();
    expect(ai.requests).toBe(3);
    expect(ai.failures).toBe(1);
    expect(ai.totalTokens).toBe(3000);
    // The 45s rate-limited request must not enter the latency figures.
    expect(ai.p95LatencyMs).toBe(1200);
    expect(ai.byFeature[0].feature).toBe('tutor_answer');
    expect(ai.fallbackRate).toBeCloseTo(0.3333, 3);
  });

  it('refuses another user the project', async () => {
    const res = await projectAnalytics(bob.token, 30);
    expect(res.statusCode).toBe(404);
  });

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/analytics` });
    expect(res.statusCode).toBe(401);
  });

  it('aggregates globally across projects, with a traceable breakdown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics?days=30', headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.projects).toBe(2);
    // The sibling project's event appears globally but not in the project view.
    expect(body.activity.byType.project_created).toBe(1);
    expect(body.projects.map((p: any) => p.name)).toEqual(['Tracked', 'Untracked']);
    expect(body.projects[0].events).toBeGreaterThan(body.projects[1].events);
  });

  it('shows another user nothing of the first user"s activity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics?days=30', headers: auth(bob.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.projects).toBe(0);
    expect(body.activity.totalEvents).toBe(0);
    expect(body.ai.requests).toBe(0);
  });
});
