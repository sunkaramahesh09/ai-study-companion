import { createClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * The flashcard endpoints through real HTTP.
 *
 * The scheduler itself is unit-tested as a pure function. What can only break
 * in integration is the boundary around it: that a learner cannot write their
 * own schedule, cannot reach another learner's deck, and that the interval
 * stored in Postgres is the one the algorithm computed.
 *
 * Cards are seeded through the service role rather than generated, so these
 * cases cost no model quota and do not depend on what a model happens to write
 * today. Generation itself is covered live in the evaluation suite.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const describeIntegration = configured ? describe : describe.skip;

describeIntegration('flashcards API', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let app: FastifyInstance;
  let alice: { id: string; token: string; anonKeyClient: ReturnType<typeof createClient> };
  let bob: { id: string; token: string };
  let projectId: string;
  let conceptId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  async function makeUser(label: string) {
    const email = `cards-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email, password });
    if (e2) throw new Error(e2.message);
    return { id: data.user!.id, token: s.session!.access_token, anonKeyClient: anon };
  }

  async function seedCard(front: string, opts: { dueAt?: string; reps?: number; ease?: number } = {}) {
    const { data, error } = await admin
      .from('flashcards')
      .insert({
        project_id: projectId,
        user_id: alice.id,
        concept_id: conceptId,
        front,
        back: `The answer to ${front}`,
        due_at: opts.dueAt ?? new Date().toISOString(),
        reps: opts.reps ?? 0,
        ease: opts.ease ?? 2.5,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    [alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')]);

    const space = await app.inject({
      method: 'POST', url: '/api/spaces', headers: auth(alice.token),
      payload: { name: 'Cards Space' },
    });
    const project = await app.inject({
      method: 'POST', url: '/api/projects', headers: auth(alice.token),
      payload: { spaceId: space.json().space.id, name: 'Cards Project' },
    });
    projectId = project.json().project.id;

    const { data: concept, error } = await admin
      .from('concepts')
      .insert({ project_id: projectId, user_id: alice.id, name: 'Photosynthesis' })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    conceptId = concept!.id as string;
  });

  afterAll(async () => {
    for (const u of [alice, bob]) if (u?.id) await admin.auth.admin.deleteUser(u.id);
    await app?.close();
  });

  describe('reading a deck', () => {
    it('separates the review queue from the whole deck', async () => {
      await seedCard('Due now A');
      await seedCard('Not due yet', { dueAt: inDays(4) });

      const res = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(alice.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.cards.length).toBeGreaterThanOrEqual(2);
      expect(body.due.map((c: { front: string }) => c.front)).toContain('Due now A');
      expect(body.due.map((c: { front: string }) => c.front)).not.toContain('Not due yet');
      expect(body.totals.due).toBe(body.due.length);
    });

    it('names the concept each card came from', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(alice.token),
      });
      expect(res.json().cards[0].conceptName).toBe('Photosynthesis');
    });

    it('says when the deck comes back once nothing is due', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(alice.token),
      });
      expect(new Date(res.json().nextDueAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('counts a lapsed card as still reviewed', async () => {
      // `reps` resets to 0 on a lapse, so counting it would make the "reviewed"
      // total fall after a review — a panel that goes backwards when you use it.
      const id = await seedCard('Lapsed but seen');
      const before = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(alice.token),
      });
      const learnedBefore = before.json().totals.learned;

      await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'again' },
      });

      const after = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(alice.token),
      });
      expect(after.json().totals.learned).toBe(learnedBefore + 1);
    });

    it('does not show one learner another learner\'s deck', async () => {
      const res = await app.inject({
        method: 'GET', url: `/api/projects/${projectId}/flashcards`, headers: auth(bob.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('reviewing', () => {
    it('schedules from the rating alone and stores what the algorithm computed', async () => {
      const id = await seedCard('Where does photosynthesis happen?');

      const res = await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'good' },
      });
      expect(res.statusCode).toBe(200);
      const card = res.json().card;

      // First success is the fixed one-day learning step.
      expect(card.intervalDays).toBe(1);
      expect(card.reps).toBe(1);
      expect(card.lastRating).toBe('good');

      // And dueAt agrees with the interval, rather than being a second opinion.
      const gapDays = (new Date(card.dueAt).getTime() - Date.now()) / 86_400_000;
      expect(gapDays).toBeGreaterThan(0.99);
      expect(gapDays).toBeLessThan(1.01);
    });

    it('brings a forgotten card back within the sitting, and counts the lapse', async () => {
      const id = await seedCard('What is chlorophyll?', { reps: 3 });

      const res = await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'again' },
      });
      const card = res.json().card;
      expect(card.lapses).toBe(1);
      expect(card.reps).toBe(0);
      const minutes = (new Date(card.dueAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(9);
      expect(minutes).toBeLessThan(11);
    });

    it('ignores a schedule the client tries to supply', async () => {
      // The attack this closes: a learner parking a card they keep forgetting
      // ten years into the future, or setting ease to 3 to inflate intervals.
      const id = await seedCard('Forgeable?');

      const res = await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'good', dueAt: inDays(3650), intervalDays: 3650, ease: 9, reps: 99 },
      });
      expect(res.statusCode).toBe(200);
      const card = res.json().card;
      expect(card.intervalDays).toBe(1);
      expect(card.ease).toBe(2.5);
      expect(card.reps).toBe(1);
    });

    it('rejects a rating the scheduler does not understand', async () => {
      const id = await seedCard('Bad rating');
      const res = await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'perfect' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('will not let one learner review another\'s card', async () => {
      const id = await seedCard('Not yours');
      const res = await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(bob.token),
        payload: { rating: 'easy' },
      });
      expect(res.statusCode).toBe(404);

      // And the card was not touched.
      const { data } = await admin.from('flashcards').select('reps').eq('id', id).single();
      expect(data!.reps).toBe(0);
    });

    it('records the review as an activity event', async () => {
      const id = await seedCard('Event check');
      await app.inject({
        method: 'POST', url: `/api/flashcards/${id}/review`, headers: auth(alice.token),
        payload: { rating: 'hard' },
      });
      const { data } = await admin
        .from('learning_events')
        .select('event_type, payload')
        .eq('project_id', projectId)
        .eq('event_type', 'flashcard_reviewed');
      expect((data ?? []).length).toBeGreaterThanOrEqual(1);
      expect(data!.some((e) => (e.payload as { cardId?: string }).cardId === id)).toBe(true);
    });
  });

  describe('deleting', () => {
    it('removes a card the learner owns', async () => {
      const id = await seedCard('Remove me');
      const res = await app.inject({
        method: 'DELETE', url: `/api/flashcards/${id}`, headers: auth(alice.token),
      });
      expect(res.statusCode).toBe(204);
      const { data } = await admin.from('flashcards').select('id').eq('id', id);
      expect(data).toHaveLength(0);
    });

    it('will not delete a card belonging to someone else', async () => {
      const id = await seedCard('Keep me');
      const res = await app.inject({
        method: 'DELETE', url: `/api/flashcards/${id}`, headers: auth(bob.token),
      });
      expect(res.statusCode).toBe(404);
      const { data } = await admin.from('flashcards').select('id').eq('id', id);
      expect(data).toHaveLength(1);
    });
  });

  describe('isolation at the database, not only the route', () => {
    it('gives a learner no way to write their own schedule through the anon key', async () => {
      const id = await seedCard('RLS check');
      const client = createClient(SUPABASE_URL!, ANON_KEY!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${alice.token}` } },
      });

      // The row IS readable — it is their own card.
      const { data: readable } = await client.from('flashcards').select('id').eq('id', id);
      expect(readable).toHaveLength(1);

      // Writing it is not. `flashcards` has a SELECT policy and nothing else,
      // so this is a no-op rather than an error (RLS filters the rows away).
      await client.from('flashcards').update({ ease: 3, interval_days: 3650 }).eq('id', id);
      const { data: after } = await admin
        .from('flashcards').select('ease, interval_days').eq('id', id).single();
      expect(Number(after!.ease)).toBe(2.5);
      expect(Number(after!.interval_days)).toBe(0);
    });

    it('cannot insert a card into a project it does not own', async () => {
      const client = createClient(SUPABASE_URL!, ANON_KEY!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${bob.token}` } },
      });
      const { error } = await client.from('flashcards').insert({
        project_id: projectId, user_id: bob.id, front: 'Planted', back: 'Planted',
      });
      expect(error).toBeTruthy();
    });
  });

  describe('generating', () => {
    it('refuses a project with no concepts rather than inventing cards', async () => {
      const space = await app.inject({
        method: 'POST', url: '/api/spaces', headers: auth(alice.token),
        payload: { name: 'Empty Space' },
      });
      const project = await app.inject({
        method: 'POST', url: '/api/projects', headers: auth(alice.token),
        payload: { spaceId: space.json().space.id, name: 'Empty Project' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.json().project.id}/flashcards/generate`,
        headers: auth(alice.token),
        payload: { count: 3 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('no_concepts');
    });

    it('will not generate into a project the caller does not own', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/projects/${projectId}/flashcards/generate`,
        headers: auth(bob.token), payload: { count: 3 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('bounds how many cards one request can ask for', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/projects/${projectId}/flashcards/generate`,
        headers: auth(alice.token), payload: { count: 500 },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
