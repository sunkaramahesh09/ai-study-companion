import {
  REVIEW_RATINGS,
  dueCards,
  newCardSchedule,
  nextDueAt,
  reviewCard,
  selectDeckConcepts,
  uuidParamSchema,
  type CardSchedule,
  type ReviewRating,
} from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';
import { recordEvent } from '../lib/events.ts';
import { generateDeck } from '../lib/flashcards.ts';
import { buildCandidates } from '../lib/quiz.ts';
import { serviceClient } from '../lib/supabase.ts';

/**
 * Flashcards (PRD "Nice to Have": flashcards, spaced repetition).
 *
 * The shape follows the quiz: the deterministic core decides which concepts a
 * deck covers and when each card returns, a model writes only the two faces,
 * and every write goes through the service role after an ownership check —
 * `flashcards` is SELECT-only for `authenticated` (migration 0010), because a
 * client that could UPDATE it could grade its own recall.
 */

/** Three cards per model call: enough to be worth the round trip, small enough for the fallback tier's TPM. */
const CARDS_PER_CONCEPT = 3;

const generateSchema = z.object({
  /** Total cards to aim for. The model returns fewer when the material is thin. */
  count: z.coerce.number().int().min(3).max(12).default(6),
  /** Narrow the deck to one concept instead of letting the selector choose. */
  conceptId: z.string().uuid().optional(),
});

// Built from the core's own list rather than a second copy of it here: a
// rating the scheduler does not understand must not be able to reach it.
const reviewSchema = z.object({
  rating: z.enum(REVIEW_RATINGS as unknown as [ReviewRating, ...ReviewRating[]]),
});

const SELECT_CARD =
  'id, project_id, concept_id, front, back, hint, due_at, interval_days, ease, reps, lapses, last_rating, last_reviewed_at, created_at';

type CardRow = {
  id: string;
  project_id: string;
  concept_id: string | null;
  front: string;
  back: string;
  hint: string | null;
  due_at: string;
  interval_days: string | number;
  ease: string | number;
  reps: number;
  lapses: number;
  last_rating: string | null;
  last_reviewed_at: string | null;
  created_at: string;
};

const scheduleOf = (row: CardRow): CardSchedule => ({
  intervalDays: Number(row.interval_days),
  ease: Number(row.ease),
  reps: row.reps,
  lapses: row.lapses,
  dueAt: new Date(row.due_at),
});

const toCard = (row: CardRow, conceptNames: Map<string, string>) => ({
  id: row.id,
  conceptId: row.concept_id,
  conceptName: row.concept_id ? (conceptNames.get(row.concept_id) ?? null) : null,
  front: row.front,
  back: row.back,
  hint: row.hint,
  dueAt: row.due_at,
  intervalDays: Number(row.interval_days),
  ease: Number(row.ease),
  reps: row.reps,
  lapses: row.lapses,
  lastRating: row.last_rating,
  lastReviewedAt: row.last_reviewed_at,
  createdAt: row.created_at,
});

export const flashcardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The project's deck, with the review queue already computed.
   *
   * `due` is derived on read from `due_at` rather than stored as a flag, for
   * the same reason growth trends are (D-049): a stored flag is wrong the
   * moment the clock moves past it.
   */
  app.get('/api/projects/:id/flashcards', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: project, error: projectError } = await req
      .db!.from('projects')
      .select('id, name')
      .eq('id', params.id)
      .eq('user_id', req.user!.id)
      .single();
    if (projectError || !project) {
      return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
    }

    const { data, error } = await req
      .db!.from('flashcards')
      .select(SELECT_CARD)
      .eq('project_id', params.id)
      .order('due_at', { ascending: true });
    if (error) return replyDbError(reply, error);

    const rows = (data ?? []) as unknown as CardRow[];
    const conceptNames = await loadConceptNames(req.db!, params.id);
    const now = new Date();
    const withDue = rows.map((r) => ({ id: r.id, dueAt: new Date(r.due_at) }));
    const dueIds = new Set(dueCards(withDue, now).map((c) => c.id));

    return {
      project: { id: project.id, name: project.name },
      cards: rows.map((r) => toCard(r, conceptNames)),
      due: rows.filter((r) => dueIds.has(r.id)).map((r) => toCard(r, conceptNames)),
      nextDueAt: nextDueAt(withDue, now)?.toISOString() ?? null,
      totals: {
        cards: rows.length,
        due: dueIds.size,
        // `last_reviewed_at`, not `reps > 0`. A lapse resets the streak to 0,
        // so counting reps would quietly un-review a card the learner has seen
        // five times — the panel would go DOWN after a review.
        learned: rows.filter((r) => r.last_reviewed_at !== null).length,
      },
    };
  });

  /**
   * Generates cards for the concepts that need them most.
   *
   * Which concepts is `selectDeckConcepts` — the quiz selector — so a deck is
   * about the same weaknesses the rest of the system is already tracking, and
   * not a second opinion that could disagree with the recommendations.
   */
  app.post(
    '/api/projects/:id/flashcards/generate',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const params = parseOrReply(uuidParamSchema, req.params, reply);
      if (!params) return;
      const body = parseOrReply(generateSchema, req.body ?? {}, reply);
      if (!body) return;

      const { data: project, error: projectError } = await req
        .db!.from('projects')
        .select('id')
        .eq('id', params.id)
        .eq('user_id', req.user!.id)
        .single();
      if (projectError || !project) {
        return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
      }

      const now = new Date();
      const candidates = await buildCandidates(req.db!, params.id, now);
      if (candidates.length === 0) {
        return reply.code(422).send({
          error: 'no_concepts',
          message:
            'This Project has no concepts yet. Upload material and let it finish processing, then try again.',
        });
      }

      const wanted = Math.ceil(body.count / CARDS_PER_CONCEPT);
      const chosen = body.conceptId
        ? candidates
            .filter((c) => c.conceptId === body.conceptId)
            .map((c) => ({ conceptId: c.conceptId, name: c.name }))
        : selectDeckConcepts(candidates, now, wanted).map((r) => ({
            conceptId: r.conceptId,
            name: r.name,
          }));

      if (chosen.length === 0) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'That concept is not in this Project.' });
      }

      // Existing fronts, so a second "Generate" adds to the deck instead of
      // asking the model to write what is already there.
      const { data: existing } = await req
        .db!.from('flashcards')
        .select('front')
        .eq('project_id', params.id);
      const avoidFronts = (existing ?? []).map((r) => r.front as string);

      const created: CardRow[] = [];
      const failures: { concept: string; reason: string }[] = [];
      // Cards the model wrote that the deck already had. Counted rather than
      // treated as an error: asking for more cards on a concept that is well
      // covered is a reasonable thing to do and a reasonable thing to say no to.
      let duplicates = 0;

      // Sequential, not Promise.all. Each call goes through the same TPM
      // limiter, which WAITS rather than failing — firing them together only
      // queues them behind each other while holding more memory.
      for (const concept of chosen) {
        try {
          const deck = await generateDeck({
            db: req.db!,
            projectId: params.id,
            userId: req.user!.id,
            conceptName: concept.name,
            count: CARDS_PER_CONCEPT,
            avoidFronts: [...avoidFronts, ...created.map((c) => c.front)],
          });

          const schedule = newCardSchedule(now);
          const rows = deck.cards.map((card) => ({
            project_id: params.id,
            user_id: req.user!.id,
            concept_id: concept.conceptId,
            front: card.front,
            back: card.back,
            hint: card.hint ?? null,
            source_chunk_ids: deck.sourceChunkIds,
            due_at: schedule.dueAt.toISOString(),
            interval_days: schedule.intervalDays,
            ease: schedule.ease,
          }));

          // Service role: `flashcards` has no INSERT policy for authenticated.
          // `ignoreDuplicates` makes regeneration idempotent against the
          // (project_id, front) unique index rather than 409-ing the whole
          // batch because one card came back the same.
          const { data: inserted, error } = await serviceClient()
            .from('flashcards')
            .upsert(rows, { onConflict: 'project_id,front', ignoreDuplicates: true })
            .select(SELECT_CARD);
          if (error) {
            failures.push({ concept: concept.name, reason: error.message });
            continue;
          }
          const newRows = (inserted ?? []) as unknown as CardRow[];
          duplicates += rows.length - newRows.length;
          created.push(...newRows);
        } catch (err) {
          // One concept with no usable material must not lose the cards that
          // did generate. Reported per concept instead.
          req.log.warn({ err, concept: concept.name }, 'flashcard generation failed');
          failures.push({
            concept: concept.name,
            reason: err instanceof Error ? err.message : 'Generation failed.',
          });
        }
      }

      // Nothing new, but nothing broken either: every card the model wrote was
      // already in the deck. That is a 200 with an empty list and a sentence
      // saying so — reporting it as a failure would send the learner off to
      // debug a system that is working.
      if (created.length === 0 && failures.length === 0) {
        return {
          cards: [],
          failures,
          message:
            'Your deck already covers this material — nothing new to add. Study more of it, or upload another document.',
        };
      }

      if (created.length === 0) {
        return reply.code(503).send({
          error: 'generation_failed',
          message:
            failures[0]?.reason ??
            'No cards could be generated from this Project’s material right now.',
          failures,
        });
      }

      await recordEvent({
        userId: req.user!.id,
        projectId: params.id,
        type: 'flashcards_generated',
        payload: {
          cards: created.length,
          concepts: chosen.map((c) => c.name),
          requested: body.count,
          duplicates,
          failures: failures.length,
        },
      });

      const conceptNames = await loadConceptNames(req.db!, params.id);
      return reply.code(201).send({
        cards: created.map((r) => toCard(r, conceptNames)),
        failures,
      });
    },
  );

  /**
   * Records one review and schedules the card's next appearance.
   *
   * The client sends a rating and nothing else. The interval, ease and due date
   * are computed here by the pure scheduler — a body carrying `dueAt` would let
   * a learner park a card they keep forgetting a year into the future.
   *
   * It deliberately does NOT touch mastery. A self-rated recall is self-report,
   * and mixing it into a score built from graded answers would quietly corrupt
   * the measure the whole adaptive system runs on (D-081).
   */
  app.post('/api/flashcards/:id/review', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const body = parseOrReply(reviewSchema, req.body, reply);
    if (!body) return;

    const { data: card, error } = await req
      .db!.from('flashcards')
      .select(SELECT_CARD)
      .eq('id', params.id)
      .eq('user_id', req.user!.id)
      .single();
    if (error || !card) {
      return reply.code(404).send({ error: 'not_found', message: 'Card not found.' });
    }

    const row = card as unknown as CardRow;
    const now = new Date();
    const next = reviewCard(scheduleOf(row), body.rating, now);

    const { data: updated, error: updateError } = await serviceClient()
      .from('flashcards')
      .update({
        due_at: next.dueAt.toISOString(),
        interval_days: next.intervalDays,
        ease: next.ease,
        reps: next.reps,
        lapses: next.lapses,
        last_rating: body.rating,
        last_reviewed_at: now.toISOString(),
      })
      .eq('id', params.id)
      // Belt and braces: the service role bypasses RLS, so ownership is
      // re-asserted in the filter rather than trusted from the read above.
      .eq('user_id', req.user!.id)
      .select(SELECT_CARD)
      .single();
    if (updateError) return replyDbError(reply, updateError);

    await recordEvent({
      userId: req.user!.id,
      projectId: row.project_id,
      type: 'flashcard_reviewed',
      payload: {
        cardId: row.id,
        conceptId: row.concept_id,
        rating: body.rating,
        intervalDays: next.intervalDays,
        lapses: next.lapses,
      },
    });

    const conceptNames = await loadConceptNames(req.db!, row.project_id);
    return { card: toCard(updated as unknown as CardRow, conceptNames) };
  });

  /** Removes a card. A wrong or unhelpful card should be deletable, not endured. */
  app.delete('/api/flashcards/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: card } = await req
      .db!.from('flashcards')
      .select('id')
      .eq('id', params.id)
      .eq('user_id', req.user!.id)
      .single();
    if (!card) return reply.code(404).send({ error: 'not_found', message: 'Card not found.' });

    const { error } = await serviceClient()
      .from('flashcards')
      .delete()
      .eq('id', params.id)
      .eq('user_id', req.user!.id);
    if (error) return replyDbError(reply, error);
    return reply.code(204).send();
  });
};

/** Concept names for the cards on screen — one query, not one per card. */
async function loadConceptNames(
  db: Parameters<typeof buildCandidates>[0],
  projectId: string,
): Promise<Map<string, string>> {
  const { data } = await db.from('concepts').select('id, name').eq('project_id', projectId);
  return new Map((data ?? []).map((c) => [c.id as string, c.name as string]));
}
