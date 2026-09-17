import { uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';
import { recordEvent } from '../lib/events.ts';
import { askTutor } from '../lib/tutor.ts';

const askSchema = z.object({
  projectId: z.string().uuid(),
  question: z.string().trim().min(3, 'Ask a question.').max(2000, 'That question is too long.'),
  // nullish, not optional: JSON clients routinely send `null` to mean "no
  // value", and rejecting that with a 400 is pedantry rather than validation.
  // Normalised to undefined so the handler has one absent case to reason about.
  conversationId: z
    .string()
    .uuid()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const tutorRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/conversations', { preHandler: app.requireAuth }, async (req, reply) => {
    const query = z.object({ projectId: z.string().uuid() }).safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'projectId is required.' });
    }
    const { data, error } = await req
      .db!.from('conversations')
      .select('id, title, created_at, updated_at')
      .eq('project_id', query.data.projectId)
      .order('updated_at', { ascending: false });
    if (error) return replyDbError(reply, error);
    return { conversations: data };
  });

  app.get('/api/conversations/:id/messages', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;
    const { data, error } = await req
      .db!.from('messages')
      .select('id, role, content, citations, grounded, created_at')
      .eq('conversation_id', params.id)
      .order('created_at', { ascending: true });
    if (error) return replyDbError(reply, error);
    return { messages: data };
  });

  /**
   * Ask the Tutor.
   *
   * NOT cached, deliberately and permanently. A Tutor answer depends on this
   * learner's question, their material and their current state; returning a
   * stored answer to a similar-looking question would be a correctness bug, not
   * a performance win (CLAUDE.md). Only reusable generations — a question for a
   * given concept and difficulty — are cached, in task 15.
   */
  app.post('/api/tutor/ask', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = parseOrReply(askSchema, req.body, reply);
    if (!body) return;

    // Ownership check through RLS: not the caller's project, no rows, stop here.
    const { data: project, error: projectError } = await req
      .db!.from('projects')
      .select('id, goal')
      .eq('id', body.projectId)
      .single();
    if (projectError || !project) {
      return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
    }

    // Reuse the conversation when given one, else open a new one titled from
    // the first question so the sidebar is readable without another AI call.
    let conversationId = body.conversationId;
    if (conversationId) {
      const { data: existing } = await req
        .db!.from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('project_id', body.projectId)
        .single();
      if (!existing) conversationId = undefined;
    }

    if (!conversationId) {
      const { data: created, error } = await req
        .db!.from('conversations')
        .insert({
          project_id: body.projectId,
          user_id: req.user!.id,
          title: body.question.slice(0, 80),
        })
        .select('id')
        .single();
      if (error) return replyDbError(reply, error);
      conversationId = created.id;
    }

    // Recent turns only — continuity without shipping the whole transcript.
    const { data: history } = await req
      .db!.from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(6);

    // Durable learner context, most salient first (PRD §11). Populated by
    // task 19; retrieving it here now means the Tutor improves without a
    // rewrite once facts start existing.
    const { data: facts } = await req
      .db!.from('learner_facts')
      .select('kind, content')
      .eq('project_id', body.projectId)
      .order('salience', { ascending: false })
      .limit(4);

    await req.db!.from('messages').insert({
      conversation_id: conversationId,
      project_id: body.projectId,
      user_id: req.user!.id,
      role: 'user',
      content: body.question,
    });

    await recordEvent({
      userId: req.user!.id,
      projectId: body.projectId,
      type: 'tutor_question',
      payload: { conversationId, length: body.question.length },
    });

    let answer;
    try {
      answer = await askTutor(req.db!, {
        userId: req.user!.id,
        projectId: body.projectId,
        question: body.question,
        goal: project.goal,
        history: (history ?? []).reverse().map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content as string,
        })),
        facts: (facts ?? []) as { kind: string; content: string }[],
      });
    } catch (err) {
      req.log.error({ err }, 'tutor generation failed');
      // The learner's question is already persisted, so the conversation stays
      // coherent and they can retry without retyping.
      return reply.code(503).send({
        error: 'tutor_unavailable',
        message: 'The Tutor is temporarily unavailable. Your question was saved — please try again.',
        conversationId,
      });
    }

    const { data: saved, error: saveError } = await req
      .db!.from('messages')
      .insert({
        conversation_id: conversationId,
        project_id: body.projectId,
        user_id: req.user!.id,
        role: 'assistant',
        content: answer.answer,
        citations: answer.citations,
        grounded: answer.grounded,
      })
      .select('id, role, content, citations, grounded, created_at')
      .single();
    if (saveError) return replyDbError(reply, saveError);

    await req
      .db!.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    // A refusal is recorded as its own event type. Being able to measure how
    // often the Tutor declines is the point — it is a core evaluation
    // requirement, not an error (PRD §7).
    await recordEvent({
      userId: req.user!.id,
      projectId: body.projectId,
      type: answer.grounded ? 'tutor_answer' : 'tutor_unsupported',
      payload: {
        conversationId,
        reason: answer.reason,
        citations: answer.citations.length,
        retrieved: answer.retrieved,
        bestDistance: answer.bestDistance,
        model: answer.model,
        latencyMs: answer.latencyMs,
      },
    });

    return {
      conversationId,
      message: saved,
      grounded: answer.grounded,
      reason: answer.reason,
      diagnostics: {
        retrieved: answer.retrieved,
        bestDistance: answer.bestDistance,
        model: answer.model,
        usedFallback: answer.usedFallback,
        latencyMs: answer.latencyMs,
      },
    };
  });
};
