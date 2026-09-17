import { uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';
import { recordEvent } from '../lib/events.ts';
import { generateQuestion, markBankUsed, saveToBank } from '../lib/questions.ts';
import { applyMastery, chooseNext } from '../lib/quiz.ts';
import { serviceClient } from '../lib/supabase.ts';

const startSchema = z.object({
  projectId: z.string().uuid(),
  targetLength: z.coerce.number().int().min(1).max(20).default(5),
});

const answerSchema = z.object({
  questionId: z.string().uuid(),
  /** MCQ answer. Open-ended answers arrive as `text` in task 16. */
  selectedIndex: z.number().int().min(0).max(3),
});

/** Never sent to the client while a question is unanswered. */
const PUBLIC_QUESTION = 'id, position, question_type, difficulty, prompt, options, concept_id';

export const quizRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Starts an attempt and issues the first question.
   *
   * The concept and difficulty come from the deterministic selector in
   * `@asc/shared`; only the wording is generated. The selector's reasoning is
   * returned alongside so adaptivity is inspectable rather than magic.
   */
  app.post('/api/quizzes', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parseOrReply(startSchema, req.body, reply);
    if (!body) return;

    const { data: project, error: projectError } = await req
      .db!.from('projects')
      .select('id')
      .eq('id', body.projectId)
      .single();
    if (projectError || !project) {
      return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
    }

    // One open attempt per project: resuming beats silently abandoning work.
    const { data: open } = await req
      .db!.from('quiz_attempts')
      .select('id')
      .eq('project_id', body.projectId)
      .eq('status', 'in_progress')
      .limit(1);
    if (open && open.length > 0) {
      return reply.code(409).send({
        error: 'conflict',
        message: 'You already have a quiz in progress.',
        attemptId: open[0]!.id,
      });
    }

    const selection = await chooseNext(req.db!, body.projectId, []);
    if (!selection) {
      return reply.code(422).send({
        error: 'no_concepts',
        message:
          'This Project has no concepts yet. Upload material and let it finish processing, then try again.',
      });
    }

    const { data: attempt, error } = await req
      .db!.from('quiz_attempts')
      .insert({
        project_id: body.projectId,
        user_id: req.user!.id,
        target_length: body.targetLength,
        status: 'in_progress',
      })
      .select('id, target_length, questions_answered, correct_count, status, started_at')
      .single();
    if (error) return replyDbError(reply, error);

    let question;
    try {
      question = await issueQuestion(req, attempt.id, body.projectId, selection, 0);
    } catch (err) {
      // Roll the attempt back rather than leaving an empty quiz the learner
      // cannot continue or restart.
      await req.db!.from('quiz_attempts').delete().eq('id', attempt.id);
      req.log.error({ err }, 'first question generation failed');
      return reply.code(503).send({
        error: 'generation_failed',
        message: err instanceof Error ? err.message : 'Could not generate a question.',
      });
    }

    await recordEvent({
      userId: req.user!.id,
      projectId: body.projectId,
      type: 'quiz_started',
      payload: { attemptId: attempt.id, targetLength: body.targetLength },
      idempotencyKey: `quiz_started:${attempt.id}`,
    });

    return reply.code(201).send({ attempt, question, selection: selection.reason });
  });

  app.get('/api/quizzes/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: attempt, error } = await req
      .db!.from('quiz_attempts')
      .select('id, project_id, status, target_length, questions_answered, correct_count, score, started_at, completed_at')
      .eq('id', params.id)
      .single();
    if (error) return replyDbError(reply, error);

    const { data: questions } = await req
      .db!.from('quiz_questions')
      .select('id, position, question_type, difficulty, prompt, options, user_answer, is_correct, score, feedback, answered_at, concept_id')
      .eq('attempt_id', params.id)
      .order('position', { ascending: true });

    return {
      attempt,
      // Strip correct_index from unanswered questions — see submitAnswer.
      questions: (questions ?? []).map((q) => (q.answered_at ? q : { ...q, is_correct: null, feedback: null })),
    };
  });

  /**
   * Submits an answer, grades it, updates mastery, and issues the next question.
   *
   * Grading for MCQ is a comparison, not an AI call. The correct index is in the
   * database; asking a model to mark it would be slower, cost tokens and
   * occasionally be wrong.
   */
  app.post('/api/quizzes/:id/answer', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const body = parseOrReply(answerSchema, req.body, reply);
    if (!body) return;

    const { data: attempt, error: attemptError } = await req
      .db!.from('quiz_attempts')
      .select('id, project_id, status, target_length, questions_answered, correct_count')
      .eq('id', params.id)
      .single();
    if (attemptError) return replyDbError(reply, attemptError);
    if (attempt.status !== 'in_progress') {
      return reply.code(409).send({ error: 'conflict', message: 'This quiz is already finished.' });
    }

    const { data: question, error: questionError } = await req
      .db!.from('quiz_questions')
      .select('id, position, concept_id, difficulty, correct_index, expected_points, answered_at, prompt')
      .eq('id', body.questionId)
      .eq('attempt_id', params.id)
      .single();
    if (questionError) return replyDbError(reply, questionError);

    // Idempotent: re-submitting the same answer must not double-count mastery.
    if (question.answered_at) {
      return reply.code(409).send({ error: 'conflict', message: 'That question is already answered.' });
    }

    const answeredAt = new Date();
    const isCorrect = body.selectedIndex === question.correct_index;
    const correctness = isCorrect ? 1 : 0;

    // Service role: quiz_questions is SELECT-only for `authenticated`, so a
    // learner cannot mark their own answers correct. Scoped to the caller's id
    // explicitly, since the service role bypasses RLS.
    await serviceClient()
      .from('quiz_questions')
      .update({
        user_answer: String(body.selectedIndex),
        is_correct: isCorrect,
        score: correctness,
        answered_at: answeredAt.toISOString(),
        feedback: {
          correctIndex: question.correct_index,
          explanation: (question.expected_points as { explanation?: string } | null)?.explanation ?? null,
        },
      })
      .eq('id', question.id)
      .eq('user_id', req.user!.id);

    let mastery = null;
    if (question.concept_id) {
      mastery = await applyMastery(req.db!, {
        projectId: attempt.project_id,
        userId: req.user!.id,
        conceptId: question.concept_id,
        correctness,
        difficulty: question.difficulty,
        answeredAt,
        sourceId: question.id,
      });
    }

    const answered = attempt.questions_answered + 1;
    const correct = attempt.correct_count + (isCorrect ? 1 : 0);
    const finished = answered >= attempt.target_length;

    await req
      .db!.from('quiz_attempts')
      .update({
        questions_answered: answered,
        correct_count: correct,
        ...(finished
          ? { status: 'completed', completed_at: answeredAt.toISOString(), score: correct / answered }
          : {}),
      })
      .eq('id', attempt.id);

    await recordEvent({
      userId: req.user!.id,
      projectId: attempt.project_id,
      type: 'question_answered',
      payload: { attemptId: attempt.id, questionId: question.id, isCorrect, difficulty: question.difficulty },
      idempotencyKey: `question_answered:${question.id}`,
    });

    if (mastery) {
      await recordEvent({
        userId: req.user!.id,
        projectId: attempt.project_id,
        type: 'mastery_updated',
        payload: { conceptId: mastery.conceptId, before: mastery.before, after: mastery.after, delta: mastery.delta },
        idempotencyKey: `mastery_updated:${question.id}`,
      });
    }

    const result = {
      isCorrect,
      correctIndex: question.correct_index,
      explanation: (question.expected_points as { explanation?: string } | null)?.explanation ?? null,
      mastery,
      progress: { answered, correct, target: attempt.target_length },
    };

    if (finished) {
      await recordEvent({
        userId: req.user!.id,
        projectId: attempt.project_id,
        type: 'quiz_completed',
        payload: { attemptId: attempt.id, score: correct / answered, answered },
        idempotencyKey: `quiz_completed:${attempt.id}`,
      });
      return { ...result, finished: true, question: null, score: correct / answered };
    }

    const asked = await askedConceptIds(req, attempt.id);
    const selection = await chooseNext(req.db!, attempt.project_id, asked);
    if (!selection) return { ...result, finished: true, question: null, score: correct / answered };

    try {
      const next = await issueQuestion(req, attempt.id, attempt.project_id, selection, answered);
      return { ...result, finished: false, question: next, selection: selection.reason };
    } catch (err) {
      req.log.error({ err }, 'next question generation failed');
      // The answer is already recorded, so end the attempt cleanly rather than
      // losing the learner's progress.
      await req
        .db!.from('quiz_attempts')
        .update({ status: 'completed', completed_at: new Date().toISOString(), score: correct / answered })
        .eq('id', attempt.id);
      return { ...result, finished: true, question: null, score: correct / answered, endedEarly: true };
    }
  });

  app.post('/api/quizzes/:id/abandon', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const { data, error } = await req
      .db!.from('quiz_attempts')
      .update({ status: 'abandoned', completed_at: new Date().toISOString() })
      .eq('id', params.id)
      .eq('status', 'in_progress')
      .select('id');
    if (error) return replyDbError(reply, error);
    if (!data || data.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'No quiz in progress.' });
    }
    return { ok: true };
  });
};

async function askedConceptIds(req: { db?: unknown }, attemptId: string): Promise<string[]> {
  const db = req.db as import('@supabase/supabase-js').SupabaseClient;
  const { data } = await db.from('quiz_questions').select('concept_id').eq('attempt_id', attemptId);
  return (data ?? []).map((r) => r.concept_id as string).filter(Boolean);
}

/**
 * Generates, persists and returns the next question.
 *
 * `correct_index` is stored but never included in the response. The client
 * needs the options to render, not the answer — shipping it would make the quiz
 * trivially cheatable from the network tab.
 */
async function issueQuestion(
  req: { db?: unknown; user?: { id: string } },
  attemptId: string,
  projectId: string,
  selection: { conceptId: string; conceptName: string; difficulty: number },
  position: number,
) {
  const db = req.db as import('@supabase/supabase-js').SupabaseClient;
  const userId = req.user!.id;

  const { data: previous } = await db
    .from('quiz_questions')
    .select('prompt')
    .eq('attempt_id', attemptId);

  const generated = await generateQuestion({
    db,
    projectId,
    userId,
    conceptId: selection.conceptId,
    conceptName: selection.conceptName,
    difficulty: selection.difficulty,
    avoidPrompts: (previous ?? []).map((p) => p.prompt as string),
  });

  await saveToBank(db, { projectId, userId, conceptId: selection.conceptId, difficulty: selection.difficulty }, generated);
  if (generated.fromCache) await markBankUsed(db, generated.question.prompt, selection.conceptId);

  // Service role for the same reason as the answer update: the client must not
  // be able to author questions. correct_index is stored here and deliberately
  // excluded from PUBLIC_QUESTION.
  const { data, error } = await serviceClient()
    .from('quiz_questions')
    .insert({
      attempt_id: attemptId,
      project_id: projectId,
      user_id: userId,
      concept_id: selection.conceptId,
      position,
      question_type: 'mcq',
      difficulty: selection.difficulty,
      prompt: generated.question.prompt,
      options: generated.question.options,
      correct_index: generated.question.correctIndex,
      expected_points: { explanation: generated.question.explanation },
      source_chunk_ids: generated.sourceChunkIds,
    })
    .select(PUBLIC_QUESTION)
    .single();

  if (error) throw new Error(`Could not save question: ${error.message}`);
  return { ...data, conceptName: selection.conceptName, fromCache: generated.fromCache };
}
