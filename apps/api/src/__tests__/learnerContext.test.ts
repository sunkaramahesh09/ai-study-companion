import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { processMaterial } from '../jobs/materialProcess.ts';
import { serviceClient } from '../lib/supabase.ts';
import { stopQueue } from '../lib/queue.ts';
import { makePdf } from './fixtures/makePdf.ts';

/**
 * Task 19: persistent learning context reaching the Tutor.
 *
 * The PRD (§11) asks for context that persists across sessions and is
 * retrieved *selectively*. The selection itself is unit-tested as a pure
 * function; what this proves is the part that can only break in integration —
 * that a fact stored days ago is fetched with its concept, narrowed against
 * the evidence this question retrieved, and actually reaches the prompt.
 *
 * The assertion is on `diagnostics.factsUsed`, not on the answer's wording. A
 * model's phrasing is not a contract; what the server chose to send is.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ = process.env.GROQ_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && GROQ && GEMINI);
const describeLive = configured ? describe : describe.skip;

const AI_TIMEOUT = 180_000;

describeLive('persistent learning context', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let userId: string;
  let token: string;
  let projectId: string;

  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  async function ask(question: string) {
    const res = await app.inject({
      method: 'POST', url: '/api/tutor/ask', headers: auth(),
      payload: { projectId, question },
    });
    return res.json() as {
      grounded: boolean;
      reason: string;
      diagnostics: { factsUsed: string[] };
      message: { content: string };
    };
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const email = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    userId = data.user!.id;

    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(signInError.message);
    token = session.session!.access_token;

    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: userId, name: 'Context' }).select('id').single();
    const { data: project } = await serviceClient()
      .from('projects')
      .insert({ space_id: space!.id, user_id: userId, name: 'Cell Biology', goal: 'Pass a first-year exam' })
      .select('id').single();
    projectId = project!.id;

    const materialId = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
    const bytes = makePdf([
      'Mitochondria are the organelles where aerobic respiration takes place. ' +
        'They convert glucose and oxygen into ATP, the energy currency of the cell. ' +
        'Each mitochondrion has an inner membrane folded into cristae, which increases ' +
        'the surface area available for the electron transport chain.',
      'Ribosomes are the site of protein synthesis. They read messenger RNA and ' +
        'assemble amino acids into polypeptide chains. Ribosomes are found free in ' +
        'the cytoplasm and bound to the rough endoplasmic reticulum.',
    ]);
    const up = await serviceClient()
      .storage.from('materials')
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    const { error: insErr } = await serviceClient().from('materials').insert({
      id: materialId, project_id: projectId, user_id: userId,
      filename: 'Cell Biology.pdf', storage_path: storagePath,
      size_bytes: bytes.length, status: 'queued',
    });
    if (insErr) throw new Error(insErr.message);
    await processMaterial({ materialId, userId, projectId });

    // A concept the learner is known to be weak on, and the durable fact that
    // records it — exactly what the quiz-completion job writes.
    const { data: concept, error: cErr } = await serviceClient()
      .from('concepts')
      .insert({ project_id: projectId, user_id: userId, name: 'Mitochondria' })
      .select('id').single();
    if (cErr) throw new Error(cErr.message);

    const { error: fErr } = await serviceClient().from('learner_facts').insert([
      {
        project_id: projectId, user_id: userId, kind: 'weakness',
        concept_id: concept!.id, salience: 0.8, evidence_count: 3,
        content: 'Mixes up the inner and outer mitochondrial membranes.',
        // Deliberately not "now": this is the point of persistence — a fact
        // written in an earlier session must still apply in this one.
        last_seen_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      {
        project_id: projectId, user_id: userId, kind: 'weakness',
        concept_id: null, salience: 0.9, evidence_count: 4,
        content: 'Struggles to describe photosynthesis light reactions.',
        last_seen_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ]);
    if (fErr) throw new Error(fErr.message);
  }, 180_000);

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
    await app?.close();
    await stopQueue();
  });

  it(
    'carries a weakness written in an earlier session into a relevant answer',
    async () => {
      const r = await ask('How do mitochondria produce ATP?');
      expect(r.grounded).toBe(true);
      expect(r.diagnostics.factsUsed).toContain('weakness');
    },
    AI_TIMEOUT,
  );

  it(
    'leaves an unrelated weakness out of the prompt',
    async () => {
      // The failure this prevents: every answer opening with the learner's
      // whole profile. Sending a photosynthesis weakness into a question about
      // ribosomes is both a non-sequitur and evidence not sent — TPM is the
      // binding constraint on this provider.
      const r = await ask('What do ribosomes do?');
      expect(r.grounded).toBe(true);
      expect(r.diagnostics.factsUsed).not.toContain('weakness');
    },
    AI_TIMEOUT,
  );
});
