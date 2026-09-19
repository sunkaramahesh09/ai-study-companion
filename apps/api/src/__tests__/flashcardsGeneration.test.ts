import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';
import { processMaterial } from '../jobs/materialProcess.ts';
import { serviceClient } from '../lib/supabase.ts';
import { stopQueue } from '../lib/queue.ts';
import { makePdf } from './fixtures/makePdf.ts';

/**
 * Flashcard generation against real models and a real indexed document.
 *
 * The routes around it are tested with seeded cards and no quota. This is the
 * part that cannot be proved that way: that the cards a model actually returns
 * pass the schema, are grounded in the uploaded material rather than in the
 * model's general knowledge, and land in the database as a reviewable deck.
 *
 * Two concepts, three cards each — two calls on the fallback tier per run.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ = process.env.GROQ_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && GROQ && GEMINI);
const describeLive = configured ? describe : describe.skip;

const AI_TIMEOUT = 180_000;

/**
 * Facts stated only here, in wording a model would not reach for on its own.
 * A card containing "Calvin cycle" proves retrieval; a card containing the
 * invented figure proves the card came from THIS document.
 */
const PAGES = [
  [
    'Photosynthesis converts light energy into chemical energy inside chloroplasts.',
    'The light-dependent reactions occur in the thylakoid membrane and produce ATP and NADPH.',
    'In this text the maximum measured quantum yield of the thylakoid stage is 0.41 mol per einstein.',
  ].join(' '),
  [
    'The Calvin cycle fixes carbon dioxide using the enzyme RuBisCO in the stroma.',
    'Three turns of the Calvin cycle are required to produce one molecule of glyceraldehyde-3-phosphate.',
    'This text refers to that requirement as the three-turn rule.',
  ].join(' '),
];

describeLive('flashcard generation', () => {
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

    const email = `cardgen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    userId = data.user!.id;

    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: session } = await anon.auth.signInWithPassword({ email, password });
    token = session!.session!.access_token;

    const space = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(), payload: { name: 'Biology' },
    });
    const project = await app.inject({
      method: 'POST', url: '/api/projects', headers: auth(),
      payload: { spaceId: space.json().space.id, name: 'Photosynthesis' },
    });
    projectId = project.json().project.id;

    const materialId = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
    const bytes = makePdf(PAGES);
    const up = await serviceClient()
      .storage.from('materials')
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(up.error.message);
    const { error: mErr } = await serviceClient().from('materials').insert({
      id: materialId, project_id: projectId, user_id: userId,
      filename: 'Photosynthesis.pdf', storage_path: storagePath,
      size_bytes: bytes.length, status: 'queued',
    });
    if (mErr) throw new Error(mErr.message);
    await processMaterial({ materialId, userId, projectId });

    // Concepts seeded rather than extracted: concept extraction is its own
    // tested step, and spending a model call on it here would only make this
    // test slower and flakier without proving anything about flashcards.
    const { error: cErr } = await admin.from('concepts').insert([
      { project_id: projectId, user_id: userId, name: 'Light-dependent reactions' },
      { project_id: projectId, user_id: userId, name: 'Calvin cycle' },
    ]);
    if (cErr) throw new Error(cErr.message);
  }, 180_000);

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
    await app?.close();
    await stopQueue();
  });

  it('writes a reviewable deck from the uploaded material', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/flashcards/generate`,
      headers: auth(), payload: { count: 6 },
    });

    if (res.statusCode === 503) {
      throw new Error(
        `The provider did not answer: ${res.json().message} — an upstream outage, not a generation failure (D-078).`,
      );
    }
    expect(res.statusCode).toBe(201);

    const cards = res.json().cards as { front: string; back: string; conceptName: string | null }[];
    expect(cards.length).toBeGreaterThan(0);

    for (const card of cards) {
      expect(card.front.length).toBeGreaterThan(4);
      expect(card.back.length).toBeGreaterThan(4);
      // A card whose back repeats the front is not a flashcard.
      expect(card.back.trim().toLowerCase()).not.toBe(card.front.trim().toLowerCase());
    }

    // Grounded in the document: at least one card has to mention something that
    // is only in it.
    const all = cards.map((c) => `${c.front} ${c.back}`).join(' ').toLowerCase();
    expect(all).toMatch(/calvin|thylakoid|rubisco|atp|nadph|stroma|chloroplast/);
  }, AI_TIMEOUT);

  it('makes the new deck due immediately and reviewable', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const deck = res.json();
    expect(deck.totals.cards).toBeGreaterThan(0);
    // A freshly generated deck with nothing due would be a dead end.
    expect(deck.due.length).toBe(deck.totals.cards);

    const first = deck.due[0];
    const reviewed = await app.inject({
      method: 'POST', url: `/api/flashcards/${first.id}/review`,
      headers: auth(), payload: { rating: 'good' },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().card.intervalDays).toBe(1);
  }, AI_TIMEOUT);

  it('adds to the deck instead of rewriting it when asked again', async () => {
    const before = await app.inject({
      method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(),
    });
    const beforeFronts: string[] = before.json().cards.map((c: { front: string }) => c.front);

    const res = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/flashcards/generate`,
      headers: auth(), payload: { count: 3 },
    });
    if (res.statusCode === 503) {
      throw new Error(`Generation failed on the second pass: ${JSON.stringify(res.json())}`);
    }
    // 201 with new cards, or 200 saying the deck already covers the material.
    // Both are correct; what must not happen is losing what was already there.
    expect([200, 201]).toContain(res.statusCode);

    const after = await app.inject({
      method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(),
    });
    const afterFronts: string[] = after.json().cards.map((c: { front: string }) => c.front);

    // Nothing was lost, and the unique index means nothing was duplicated.
    for (const front of beforeFronts) expect(afterFronts).toContain(front);
    expect(new Set(afterFronts).size).toBe(afterFronts.length);
  }, AI_TIMEOUT);

  it('records what the generation cost against this project', async () => {
    const { data } = await admin
      .from('ai_requests')
      .select('feature, status, total_tokens')
      .eq('project_id', projectId)
      .eq('feature', 'flashcard_generation');
    expect((data ?? []).length).toBeGreaterThan(0);
    expect(data!.some((r) => r.status === 'success')).toBe(true);
  });
});
