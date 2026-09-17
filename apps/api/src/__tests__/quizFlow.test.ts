import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { serviceClient } from '../lib/supabase.ts';
import { stopQueue } from '../lib/queue.ts';
import { processMaterial } from '../jobs/materialProcess.ts';
import { makePdf } from './fixtures/makePdf.ts';

/**
 * The quiz answer/next split (D-059).
 *
 * Grading an MCQ is an integer comparison. Generating the next question is a
 * model call behind a token limiter that WAITS rather than failing, so while
 * the two shared a response a learner sat for close to a minute before finding
 * out whether the answer they had just given was right.
 *
 * The property under test is a TIMING one, which is unusual and deliberate:
 * "is the verdict fast" is the actual requirement, and a test that only
 * checked the response shape would pass for the slow version too.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ = process.env.GROQ_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && GROQ && GEMINI);
const describeLive = configured ? describe : describe.skip;

const AI_TIMEOUT = 240_000;

/**
 * The ceiling for returning a verdict.
 *
 * Generous — this is a live database over the network — but far below the
 * cost of a generation call, which is what it is there to exclude.
 */
const GRADING_BUDGET_MS = 5000;

describeLive('quiz answer/next split', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let userId: string;
  let token: string;
  let projectId: string;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  /**
   * Starts an attempt, abandoning any still open first.
   *
   * The route refuses a second concurrent attempt per user — correctly, since
   * two in-flight quizzes would interleave mastery updates. Each test here
   * wants its own, so it closes the previous one rather than working around
   * the guard.
   */
  async function freshAttempt(targetLength: number) {
    const { data: open } = await serviceClient()
      .from('quiz_attempts')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'in_progress');
    for (const a of open ?? []) {
      await app.inject({ method: 'POST', url: `/api/quizzes/${a.id}/abandon`, headers: auth() });
    }

    const res = await app.inject({
      method: 'POST', url: '/api/quizzes', headers: auth(), payload: { projectId, targetLength },
    });
    if (![200, 201].includes(res.statusCode)) {
      throw new Error(`could not start a quiz: ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
    return { attemptId: res.json().attempt.id as string, question: res.json().question };
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const email = `quizflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    userId = data.user!.id;

    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s } = await anon.auth.signInWithPassword({ email, password });
    token = s.session!.access_token;

    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: userId, name: 'Quiz flow' }).select('id').single();
    const { data: project } = await serviceClient()
      .from('projects').insert({ space_id: space!.id, user_id: userId, name: 'Biology' }).select('id').single();
    projectId = project!.id;

    const materialId = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
    const bytes = makePdf([
      'Cellular respiration releases energy from glucose in the mitochondria. One glucose molecule ' +
        'yields about thirty-two ATP aerobically, and only two by fermentation without oxygen.',
      'Photosynthesis converts light into chemical energy inside chloroplasts. The light reactions ' +
        'happen in the thylakoid membranes and the Calvin cycle happens in the stroma.',
    ]);
    const up = await serviceClient()
      .storage.from('materials')
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(up.error.message);
    const { error: mErr } = await serviceClient().from('materials').insert({
      id: materialId, project_id: projectId, user_id: userId,
      filename: 'Biology.pdf', storage_path: storagePath, size_bytes: bytes.length, status: 'queued',
    });
    if (mErr) throw new Error(mErr.message);
    await processMaterial({ materialId, userId, projectId });

    // Concepts are normally extracted by the chained `material.concepts` job,
    // which needs a worker. Seeded directly so this test does not depend on
    // one. Errors checked: a silent seed failure here surfaces later as a 422
    // from the quiz route, which looks like a bug in the code under test
    // (landmine 9).
    const { error: cErr } = await serviceClient()
      .from('concepts')
      .upsert(
        [
          { project_id: projectId, user_id: userId, name: 'Cellular respiration' },
          { project_id: projectId, user_id: userId, name: 'Photosynthesis' },
        ],
        { onConflict: 'project_id,name' },
      );
    if (cErr) throw new Error(`concepts: ${cErr.message}`);

    const { count } = await serviceClient()
      .from('concepts')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId);
    if (!count) throw new Error('no concepts were created; the quiz route will 422');
  }, AI_TIMEOUT);

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
    await app?.close();
    await stopQueue();
  });

  it(
    'returns the verdict fast, and the next question separately',
    async () => {
      const { attemptId, question } = await freshAttempt(3);
      expect(question?.prompt).toBeTruthy();

      const payload =
        question.question_type === 'open'
          ? { questionId: question.id, text: 'Respiration releases energy from glucose in the mitochondria as ATP.' }
          : { questionId: question.id, selectedIndex: 0 };

      const began = Date.now();
      const answer = await app.inject({
        method: 'POST', url: `/api/quizzes/${attemptId}/answer`, headers: auth(),
        payload,
      });
      const gradingMs = Date.now() - began;

      expect(answer.statusCode).toBe(200);
      const body = answer.json();

      // MCQ grading is an integer comparison; open grading is one short model
      // call. Neither should be anywhere near the cost of generating the next
      // question, which is what used to be bundled in here.
      if (question.question_type === 'mcq') {
        expect(gradingMs, `grading took ${gradingMs}ms — is it still waiting on generation?`).toBeLessThan(
          GRADING_BUDGET_MS,
        );
      }

      expect(body.mastery).not.toBeNull();
      // The response must NOT carry the next question any more.
      expect(body.question).toBeNull();
      expect(body.nextPending).toBe(true);

      const next = await app.inject({
        method: 'POST', url: `/api/quizzes/${attemptId}/next`, headers: auth(),
      });
      expect(next.statusCode).toBe(200);
      expect(next.json().finished).toBe(false);
      expect(next.json().question?.prompt).toBeTruthy();
      expect(next.json().question.id).not.toBe(question.id);
    },
    AI_TIMEOUT,
  );

  it(
    'never sends the correct answer to the client',
    async () => {
      const { attemptId, question: first } = await freshAttempt(2);

      await app.inject({
        method: 'POST', url: `/api/quizzes/${attemptId}/answer`, headers: auth(),
        payload:
          first.question_type === 'open'
            ? { questionId: first.id, text: 'Some answer about respiration.' }
            : { questionId: first.id, selectedIndex: 0 },
      });

      const next = await app.inject({
        method: 'POST', url: `/api/quizzes/${attemptId}/next`, headers: auth(),
      });
      const q = next.json().question;
      if (q) {
        // The new endpoint reshapes rows itself, so it is its own chance to
        // leak the answer out of the network tab.
        expect(Object.keys(q)).not.toContain('correct_index');
        expect(Object.keys(q)).not.toContain('correctIndex');
        expect(Object.keys(q)).not.toContain('expected_points');
      }
    },
    AI_TIMEOUT,
  );

  it(
    'is idempotent: asking twice returns the same question, not a new one',
    async () => {
      // A double-click, or a retry after a client timeout, must not burn quota
      // or silently skip a question.
      const { attemptId, question: first } = await freshAttempt(3);

      await app.inject({
        method: 'POST', url: `/api/quizzes/${attemptId}/answer`, headers: auth(),
        payload:
          first.question_type === 'open'
            ? { questionId: first.id, text: 'An answer about photosynthesis in the chloroplast.' }
            : { questionId: first.id, selectedIndex: 0 },
      });

      const a = await app.inject({ method: 'POST', url: `/api/quizzes/${attemptId}/next`, headers: auth() });
      const b = await app.inject({ method: 'POST', url: `/api/quizzes/${attemptId}/next`, headers: auth() });

      expect(a.json().question?.id).toBeTruthy();
      expect(b.json().question?.id).toBe(a.json().question?.id);
      expect(b.json().reissued).toBe(true);

      const { count } = await serviceClient()
        .from('quiz_questions')
        .select('id', { count: 'exact', head: true })
        .eq('attempt_id', attemptId);
      // One answered + one issued. A third row would mean the retry generated.
      expect(count).toBe(2);
    },
    AI_TIMEOUT,
  );

  it('refuses another user the next question', async () => {
    const { attemptId } = await freshAttempt(2);

    const otherEmail = `quizflow-other-${Date.now()}@example.test`;
    const otherPassword = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data: other } = await admin.auth.admin.createUser({
      email: otherEmail, password: otherPassword, email_confirm: true,
    });
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s } = await anon.auth.signInWithPassword({ email: otherEmail, password: otherPassword });

    const res = await app.inject({
      method: 'POST', url: `/api/quizzes/${attemptId}/next`,
      headers: { authorization: `Bearer ${s.session!.access_token}` },
    });
    expect(res.statusCode).toBe(404);

    await admin.auth.admin.deleteUser(other.user!.id);
  }, AI_TIMEOUT);
});
