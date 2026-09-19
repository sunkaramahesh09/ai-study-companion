import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serviceClient } from '../lib/supabase.ts';
import { askTutorLive } from './fixtures/askLive.ts';
import { makePdf } from './fixtures/makePdf.ts';
import { processMaterial } from '../jobs/materialProcess.ts';
import { stopQueue } from '../lib/queue.ts';

/**
 * What the user gets when the AI provider is down (PRD §15).
 *
 * The provider layer's own retry, backoff and primary→fallback failover are
 * unit-tested in `packages/ai` against a stubbed SDK. This tests the layer
 * above: what the HTTP API does once the provider has exhausted all of that
 * and still failed — which is the only part the user ever sees.
 *
 * The provider is stubbed rather than genuinely broken. Waiting for a real
 * outage is not a test strategy, and burning quota to provoke a 429 storm
 * would pollute the AI-health numbers the admin dashboard reports.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && GEMINI);
const describeIntegration = configured ? describe : describe.skip;

// Hoisted so the module mock can see it; each test sets its behaviour.
const generate = vi.hoisted(() => vi.fn());

vi.mock('../lib/ai.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ai.ts')>();
  return {
    ...actual,
    // Embeddings stay REAL: indexing has to work for retrieval to return
    // evidence, which is what gets the request as far as generation at all.
    generationProvider: () => ({ generate }),
  };
});

const { buildServer } = await import('../server.ts');

describeIntegration('provider failure reaches the user as a usable error', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let userId: string;
  let token: string;
  let projectId: string;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const email = `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    userId = data.user!.id;

    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s } = await anon.auth.signInWithPassword({ email, password });
    token = s.session!.access_token;

    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: userId, name: 'Provider' }).select('id').single();
    const { data: project } = await serviceClient()
      .from('projects').insert({ space_id: space!.id, user_id: userId, name: 'Provider' }).select('id').single();
    projectId = project!.id;

    // Real material, really indexed, so retrieval succeeds and the request
    // reaches generation — which is the failure point under test.
    const materialId = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
    const bytes = makePdf([
      'Cellular respiration releases energy from glucose inside the mitochondria of the cell.',
      'Photosynthesis converts light energy into chemical energy inside chloroplasts.',
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
  }, 120_000);

  // Braces, not a concise body: `mockReset()` returns the mock, and vitest
  // treats a hook's return value as a teardown function — so the concise form
  // calls the stub one extra time after every test.
  afterEach(() => {
    generate.mockReset();
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
    await app?.close();
    await stopQueue();
  });

  const ask = (question: string) =>
    app.inject({ method: 'POST', url: '/api/tutor/ask', headers: auth(), payload: { projectId, question } });

  it('returns 503 with a message the user can act on, not a 500', async () => {
    generate.mockRejectedValue(new Error('upstream 503 from provider'));

    const res = await ask('What does cellular respiration do?');
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('tutor_unavailable');
    expect(body.message).toMatch(/try again/i);
    // The raw upstream error must not be handed to the user.
    expect(JSON.stringify(body)).not.toMatch(/upstream 503 from provider/);
  });

  it('keeps the learner\'s question so they do not retype it', async () => {
    generate.mockRejectedValue(new Error('provider exploded'));

    const question = 'Where does photosynthesis take place inside the cell?';
    const res = await ask(question);
    expect(res.statusCode).toBe(503);

    // The conversation id comes back so the UI can stay on the same thread.
    const conversationId = res.json().conversationId;
    expect(conversationId).toBeTruthy();

    const { data: messages } = await serviceClient()
      .from('messages').select('role, content').eq('conversation_id', conversationId);
    expect(messages!.some((m) => m.role === 'user' && m.content === question)).toBe(true);
    // And no half-written assistant turn was left behind.
    expect(messages!.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('recovers on the next request once the provider comes back', async () => {
    generate.mockRejectedValueOnce(new Error('transient outage'));
    const failed = await ask('What does cellular respiration do?');
    expect(failed.statusCode).toBe(503);

    generate.mockResolvedValue({
      text: 'Cellular respiration releases energy from glucose inside the mitochondria [S1].',
      model: 'openai/gpt-oss-120b',
      usedFallback: false,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    const ok = await ask('What does cellular respiration do?');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().grounded).toBe(true);
    // No manual intervention: the failure left nothing latched.
    expect(ok.json().message.citations.length).toBeGreaterThan(0);
  });

  it('records an answer that cites nothing as ungrounded rather than passing it off', async () => {
    // The model answered, but from general knowledge — no [S#] markers. This
    // is the failure mode the whole feature exists to prevent, so it must be
    // visible in the data, not silently shown as a normal answer.
    generate.mockResolvedValue({
      text: 'Cellular respiration is how cells make energy. It happens in the mitochondria.',
      model: 'openai/gpt-oss-120b',
      usedFallback: false,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    const res = await ask('What does cellular respiration do?');
    expect(res.statusCode).toBe(200);
    expect(res.json().grounded).toBe(false);
    expect(res.json().message.citations).toHaveLength(0);

    const { data: events } = await serviceClient()
      .from('learning_events')
      .select('event_type').eq('project_id', projectId).eq('event_type', 'tutor_unsupported');
    expect((events ?? []).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The live behaviour suites read `.message.content` off every answer. When
   * the provider is down there is no `message`, and the failure surfaced as
   * `Cannot read properties of undefined` inside an injection-compliance
   * helper — a real outage reported as a security regression (D-078).
   *
   * `askTutorLive` is what they call instead. This stubs the same outage it
   * was written for, so the guarantee is checked rather than asserted in a
   * comment.
   */
  describe('askTutorLive, the helper the live suites ask through', () => {
    it('names the outage instead of dying on an undefined message', async () => {
      generate.mockRejectedValue(new Error('provider down'));

      await expect(
        askTutorLive(app, auth(), { projectId, question: 'What does cellular respiration do?' }),
      ).rejects.toThrow(/upstream outage, not a Tutor behaviour failure/);
      // Two calls, not one: it retried before giving up.
      expect(generate).toHaveBeenCalledTimes(2);
    }, 20_000);

    it('rides out a single transient failure', async () => {
      generate.mockRejectedValueOnce(new Error('transient outage'));
      generate.mockResolvedValue({
        text: 'Cellular respiration releases energy from glucose inside the mitochondria [S1].',
        model: 'openai/gpt-oss-120b',
        usedFallback: false,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      });

      const reply = await askTutorLive(app, auth(), {
        projectId,
        question: 'What does cellular respiration do?',
      });
      expect(reply.message.content).toMatch(/mitochondria/);
      expect(reply.grounded).toBe(true);
    }, 20_000);
  });
});
