import { selectQuestionType, uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';
import { recordEvent } from '../lib/events.ts';
import { generateOpenQuestion, gradeOpenAnswer } from '../lib/grading.ts';
import { generateQuestion, markBankUsed, saveToBank } from '../lib/questions.ts';
import { applyMastery, chooseNext } from '../lib/quiz.ts';
import { enqueueQuizCompleted } from '../lib/queue.ts';
import { serviceClient } from '../lib/supabase.ts';

const startSchema = z.object({
  projectId: z.string().uuid(),
  targetLength: z.coerce.number().int().min(1).max(20).default(5),
});

/**
 * One endpoint, two answer shapes. Which one is required depends on the stored
 * question type, checked in the handler — a client cannot pick its own format
 * to dodge grading.
 */
const answerSchema = z
  .object({
    questionId: z.string().uuid(),
    selectedIndex: z.number().int().min(0).max(3).optional(),
    text: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((b) => b.selectedIndex !== undefined || b.text !== undefined, {
    message: 'Provide selectedIndex for multiple choice, or text for an open answer.',
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
      .select('id, position, concept_id, difficulty, question_type, correct_index, expected_points, answered_at, prompt, concepts(name)')
      .eq('id', body.questionId)
      .eq('attempt_id', params.id)
      .single();
    if (questionError) return replyDbError(reply, questionError);

    // Idempotent: re-submitting the same answer must not double-count mastery.
    if (question.answered_at) {
      return reply.code(409).send({ error: 'conflict', message: 'That question is already answered.' });
    }

    const answeredAt = new Date();
    const isOpen = question.question_type === 'open';

    // The stored type decides which answer shape is required, so a client
    // cannot choose its own format to dodge grading.
    if (isOpen && body.text === undefined) {
      return reply.code(400).send({ error: 'invalid_request', message: 'This question needs a written answer.' });
    }
    if (!isOpen && body.selectedIndex === undefined) {
      return reply.code(400).send({ error: 'invalid_request', message: 'This question needs an option choice.' });
    }

    let correctness: number;
    let isCorrect: boolean;
    let feedback: Record<string, unknown>;
    let userAnswer: string;

    if (isOpen) {
      const rubric = (question.expected_points as { expectedPoints?: string[] } | null)?.expectedPoints ?? [];
      let grade;
      try {
        grade = await gradeOpenAnswer({
          question: question.prompt as string,
          expectedPoints: rubric,
          answer: body.text!,
          conceptName: (question.concepts as { name?: string } | null)?.name ?? 'this concept',
          userId: req.user!.id,
          projectId: attempt.project_id,
        });
      } catch (err) {
        req.log.error({ err }, 'grading failed');
        // Nothing is recorded, so the learner can resubmit rather than having an
        // ungraded attempt counted against their mastery.
        return reply.code(503).send({
          error: 'grading_unavailable',
          message: 'Could not mark that answer right now. Please try submitting again.',
        });
      }
      correctness = grade.score;
      // A partial answer is not a pass. This threshold only drives the
      // correct/incorrect counters; mastery uses the continuous score.
      isCorrect = grade.score >= 0.6;
      userAnswer = body.text!;
      feedback = { ...grade, rubric };
    } else {
      isCorrect = body.selectedIndex === question.correct_index;
      correctness = isCorrect ? 1 : 0;
      userAnswer = String(body.selectedIndex);
      feedback = {
        correctIndex: question.correct_index,
        explanation: (question.expected_points as { explanation?: string } | null)?.explanation ?? null,
      };
    }

    // Service role: quiz_questions is SELECT-only for `authenticated`, so a
    // learner cannot mark their own answers correct. Scoped to the caller's id
    // explicitly, since the service role bypasses RLS.
    await serviceClient()
      .from('quiz_questions')
      .update({
        user_answer: userAnswer,
        is_correct: isCorrect,
        score: correctness,
        answered_at: answeredAt.toISOString(),
        feedback,
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
      payload: {
        attemptId: attempt.id,
        questionId: question.id,
        isCorrect,
        score: correctness,
        questionType: question.question_type,
        difficulty: question.difficulty,
      },
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
      score: correctness,
      questionType: question.question_type,
      // MCQ reveals the right option AFTER answering; open-ended returns the
      // full breakdown of what was understood and what was missing.
      ...(isOpen
        ? { grade: feedback }
        : {
            correctIndex: question.correct_index,
            explanation: (question.expected_points as { explanation?: string } | null)?.explanation ?? null,
          }),
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

      // Hand the analysis to the worker. The learner sees their result
      // immediately; weakness detection and the recommendation complete whether
      // or not they keep the page open (PRD §13).
      try {
        await enqueueQuizCompleted({
          attemptId: attempt.id,
          userId: req.user!.id,
          projectId: attempt.project_id,
        });
      } catch (err) {
        req.log.error({ err }, 'could not enqueue quiz.completed');
      }

      return { ...result, finished: true, question: null, score: correct / answered };
    }

    // The verdict returns WITHOUT waiting for the next question.
    //
    // Grading an MCQ is an integer comparison and takes no time at all, but
    // generating the next question is a model call behind a token limiter that
    // WAITS rather than failing (D-033). Returning them together meant a
    // learner sat for close to a minute before finding out whether the answer
    // they just gave was right — the two are unrelated, and only one of them
    // is slow. The client asks for the next question separately. See D-059.
    return { ...result, finished: false, question: null, nextPending: true };
  });

  /**
   * Issues the next question of an in-progress attempt.
   *
   * Split out from `/answer` so that feedback is instant. Safe to call more
   * than once: an unanswered question already issued for this attempt is
   * returned as-is rather than generating a second one, so a double-click or a
   * retry after a timeout cannot burn quota or skip a question.
   */
  app.post('/api/quizzes/:id/next', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: attempt, error: attemptError } = await req
      .db!.from('quiz_attempts')
      .select('id, project_id, status, target_length, questions_answered, correct_count')
      .eq('id', params.id)
      .single();
    if (attemptError) return replyDbError(reply, attemptError);

    const score = attempt.questions_answered > 0 ? attempt.correct_count / attempt.questions_answered : 0;
    if (attempt.status !== 'in_progress') {
      return { finished: true, question: null, score };
    }
    if (attempt.questions_answered >= attempt.target_length) {
      return { finished: true, question: null, score };
    }

    // Already issued and not yet answered: hand back the same question.
    const { data: pending } = await req
      .db!.from('quiz_questions')
      .select('id, position, concept_id, difficulty, question_type, prompt, options, concepts(name)')
      .eq('attempt_id', attempt.id)
      .is('answered_at', null)
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (pending) {
      return { finished: false, question: shapeQuestionForClient(pending), reissued: true };
    }

    const asked = await askedConceptIds(req, attempt.id);
    const selection = await chooseNext(req.db!, attempt.project_id, asked);
    if (!selection) return { finished: true, question: null, score };

    try {
      const next = await issueQuestion(
        req,
        attempt.id,
        attempt.project_id,
        selection,
        attempt.questions_answered,
      );
      return { finished: false, question: next, selection: selection.reason };
    } catch (err) {
      req.log.error({ err }, 'next question generation failed');
      // Answers already given are recorded, so end the attempt cleanly rather
      // than losing the learner's progress.
      await req
        .db!.from('quiz_attempts')
        .update({ status: 'completed', completed_at: new Date().toISOString(), score })
        .eq('id', attempt.id);
      return { finished: true, question: null, score, endedEarly: true };
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
  const avoidPrompts = (previous ?? []).map((p) => p.prompt as string);

  // Format is a deterministic decision (@asc/shared), like concept and
  // difficulty. The model writes questions; it does not choose what kind.
  const questionType = selectQuestionType(position, selection.difficulty);

  let row: Record<string, unknown>;

  if (questionType === 'open') {
    const generated = await generateOpenQuestion({
      db,
      projectId,
      userId,
      conceptName: selection.conceptName,
      difficulty: selection.difficulty,
      avoidPrompts,
    });
    row = {
      question_type: 'open',
      prompt: generated.question.prompt,
      options: null,
      correct_index: null,
      // Rubric stored WITH the question, so grading is against a fixed standard
      // rather than one invented at marking time.
      expected_points: { expectedPoints: generated.question.expectedPoints },
      source_chunk_ids: generated.sourceChunkIds,
    };
  } else {
    const generated = await generateQuestion({
      db,
      projectId,
      userId,
      conceptId: selection.conceptId,
      conceptName: selection.conceptName,
      difficulty: selection.difficulty,
      avoidPrompts,
    });
    await saveToBank(db, { projectId, userId, conceptId: selection.conceptId, difficulty: selection.difficulty }, generated);
    if (generated.fromCache) await markBankUsed(db, generated.question.prompt, selection.conceptId);
    row = {
      question_type: 'mcq',
      prompt: generated.question.prompt,
      options: generated.question.options,
      correct_index: generated.question.correctIndex,
      expected_points: { explanation: generated.question.explanation },
      source_chunk_ids: generated.sourceChunkIds,
    };
  }

  // Service role: the client must not be able to author questions.
  // correct_index and the rubric are stored here and excluded from
  // PUBLIC_QUESTION, so neither reaches the learner before they answer.
  const { data, error } = await serviceClient()
    .from('quiz_questions')
    .insert({
      attempt_id: attemptId,
      project_id: projectId,
      user_id: userId,
      concept_id: selection.conceptId,
      position,
      difficulty: selection.difficulty,
      ...row,
    })
    .select(PUBLIC_QUESTION)
    .single();

  if (error) throw new Error(`Could not save question: ${error.message}`);
  return { ...data, conceptName: selection.conceptName };
}

/**
 * The client-safe shape of a question.
 *
 * `correct_index` and `expected_points` are deliberately absent: sending them
 * would let a learner read the answer out of the network tab, and mastery is
 * computed from what they submit.
 */
function shapeQuestionForClient(row: Record<string, unknown>) {
  const concepts = row.concepts as { name?: string } | { name?: string }[] | null;
  const conceptName = Array.isArray(concepts) ? concepts[0]?.name : concepts?.name;
  return {
    id: row.id as string,
    position: row.position as number,
    concept_id: row.concept_id as string,
    difficulty: row.difficulty as number,
    question_type: row.question_type as 'mcq' | 'open',
    prompt: row.prompt as string,
    options: (row.options as string[] | null) ?? null,
    conceptName: conceptName ?? undefined,
  };
}
