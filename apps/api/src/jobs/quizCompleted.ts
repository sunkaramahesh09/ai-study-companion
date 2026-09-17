import { detectRepeatedMistakes, emptyMastery, masteryBand, type MasteryState } from '@asc/shared';
import { recordEvent } from '../lib/events.ts';
import { evaluateTriggers, generateRecommendationText } from '../lib/recommendations.ts';
import { recentAnswers } from '../lib/quiz.ts';
import { serviceClient } from '../lib/supabase.ts';

export type QuizCompletedJob = {
  attemptId: string;
  userId: string;
  projectId: string;
};

/**
 * Post-quiz analysis: detect weaknesses, update persistent learner context, and
 * decide what to recommend next.
 *
 * Runs in the worker because the PRD is explicit that the learner "should not
 * need to keep the browser open while long-running work executes" (§13). Mastery
 * itself is applied per answer in the request path — it has to be, so the
 * learner sees it move — but everything that follows a completed quiz belongs
 * here.
 *
 * The chain the PRD describes (§13): evaluate → update mastery → detect
 * weakness → generate insight → recommend next action. Only the last step calls
 * a model, and only to write a sentence.
 *
 * Idempotency: keyed on the attempt id. Re-running re-derives the same
 * weaknesses from the same answers, upserts the same learner_facts, and the
 * recommendation cooldown (task 14) prevents a duplicate suggestion.
 */
export async function handleQuizCompleted(job: QuizCompletedJob): Promise<{
  patterns: number;
  facts: number;
  recommendation: string | null;
}> {
  const db = serviceClient();
  const { attemptId, userId, projectId } = job;
  const now = new Date();

  const { data: attempt } = await db
    .from('quiz_attempts')
    .select('id, status, score, questions_answered, completed_at')
    .eq('id', attemptId)
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .single();

  if (!attempt) {
    console.warn('[quiz.completed] attempt not found, skipping', attemptId);
    return { patterns: 0, facts: 0, recommendation: null };
  }
  if (attempt.status !== 'completed') {
    console.warn('[quiz.completed] attempt not completed, skipping', attemptId);
    return { patterns: 0, facts: 0, recommendation: null };
  }

  // --- detect weakness -----------------------------------------------------
  const answers = await recentAnswers(db, projectId, 150);
  const patterns = detectRepeatedMistakes(answers, now);

  // --- update persistent learning context ----------------------------------
  const factCount = await writeLearnerFacts(db, { userId, projectId, patterns, now });

  for (const p of patterns.filter((x) => !x.recovered)) {
    await recordEvent({
      userId,
      projectId,
      type: 'weakness_detected',
      payload: {
        conceptId: p.conceptId,
        concept: p.conceptName,
        mistakes: p.mistakes,
        errorRate: p.errorRate,
        severity: p.severity,
      },
      // Keyed on the last mistake, so re-running finds the same key rather than
      // logging the same weakness repeatedly.
      idempotencyKey: `weakness:${p.conceptId}:${p.lastMistakeAt.toISOString()}`,
    });
  }

  // --- decide whether to recommend, and what ------------------------------
  const snapshot = await buildSnapshot(db, { projectId, patterns, now });
  const trigger = evaluateTriggers(snapshot, now);

  if (!trigger) {
    console.log(`[quiz.completed] ${attemptId}: ${patterns.length} patterns, no recommendation needed`);
    return { patterns: patterns.length, facts: factCount, recommendation: null };
  }

  // Idempotency at the attempt level. Re-running must not add a second
  // recommendation: the cooldown suppresses the SAME trigger, so a re-run would
  // otherwise fall through to the next rule and create a different one.
  const { data: alreadyAdvised } = await db
    .from('recommendations')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .gte('created_at', (attempt.completed_at as string) ?? new Date(0).toISOString())
    .limit(1);

  if (alreadyAdvised && alreadyAdvised.length > 0) {
    console.log(`[quiz.completed] ${attemptId}: recommendation already exists for this attempt, skipping`);
    return { patterns: patterns.length, facts: factCount, recommendation: alreadyAdvised[0]!.id };
  }

  const { data: project } = await db
    .from('projects')
    .select('name, goal')
    .eq('id', projectId)
    .single();

  const { text, generated } = await generateRecommendationText({
    trigger,
    projectName: (project?.name as string) ?? 'this Project',
    goal: project?.goal as string | null,
    userId,
    projectId,
  });

  // Supersede every active recommendation, not just one matching this trigger.
  //
  // The PRD's question is "what should I do next?", singular (§10). Leaving
  // older advice active produces a stack of competing suggestions, and a
  // learner facing five next actions has been given none. An earlier version
  // filtered by trigger and concept and used `.is()` for the concept — which
  // only matches NULL, so a concept-specific recommendation was never actually
  // superseded. See D-047.
  await db
    .from('recommendations')
    .update({ status: 'superseded', resolved_at: now.toISOString() })
    .eq('project_id', projectId)
    .eq('status', 'active');

  const { data: created, error } = await db
    .from('recommendations')
    .insert({
      project_id: projectId,
      user_id: userId,
      concept_id: trigger.conceptId,
      trigger_reason: trigger.trigger,
      title: text.title,
      body: text.body,
      action_type: trigger.action,
      status: 'active',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Could not save recommendation: ${error.message}`);

  await recordEvent({
    userId,
    projectId,
    type: 'recommendation_created',
    payload: {
      recommendationId: created.id,
      trigger: trigger.trigger,
      conceptId: trigger.conceptId,
      action: trigger.action,
      generated,
      evidence: trigger.evidence,
    },
    idempotencyKey: `recommendation:${created.id}`,
  });

  console.log(
    `[quiz.completed] ${attemptId}: ${patterns.length} patterns, ${factCount} facts, ` +
      `recommendation "${text.title}" (${trigger.trigger}${generated ? '' : ', fallback text'})`,
  );

  return { patterns: patterns.length, facts: factCount, recommendation: created.id };
}

/**
 * Persists what we now know about this learner.
 *
 * The PRD asks for context that "prioritize[s] relevance rather than storing
 * everything" (§11), so this writes a small number of durable facts rather than
 * a transcript. `learner_facts` is unique on (project_id, kind, concept_id), so
 * re-observing a weakness raises its salience instead of appending a duplicate —
 * which is what makes the job safe to re-run.
 */
async function writeLearnerFacts(
  db: ReturnType<typeof serviceClient>,
  input: {
    userId: string;
    projectId: string;
    patterns: Awaited<ReturnType<typeof detectRepeatedMistakes>>;
    now: Date;
  },
): Promise<number> {
  const rows = input.patterns
    .filter((p) => !p.recovered)
    .slice(0, 5)
    .map((p) => ({
      project_id: input.projectId,
      user_id: input.userId,
      kind: 'mistake_pattern' as const,
      concept_id: p.conceptId,
      content:
        `Repeatedly misses questions on ${p.conceptName} ` +
        `(${p.mistakes} of ${p.attempts} recent attempts wrong, mostly at difficulty ${Math.round(p.meanDifficulty)}).`,
      // Severity drives salience, so the Tutor retrieves the worst problems
      // first when it takes the top-N facts.
      salience: p.severity === 'blocked' ? 0.95 : p.severity === 'struggling' ? 0.75 : 0.5,
      evidence_count: p.mistakes,
      last_seen_at: input.now.toISOString(),
    }));

  if (rows.length === 0) return 0;

  const { error } = await db
    .from('learner_facts')
    .upsert(rows, { onConflict: 'project_id,kind,concept_id' });

  if (error) {
    console.error('[quiz.completed] could not write learner facts:', error.message);
    return 0;
  }
  return rows.length;
}

async function buildSnapshot(
  db: ReturnType<typeof serviceClient>,
  input: { projectId: string; patterns: Awaited<ReturnType<typeof detectRepeatedMistakes>>; now: Date },
) {
  const [{ data: materials }, { data: concepts }, { data: mastery }, { data: lastQuiz }, { data: active }, { data: lastEvent }] =
    await Promise.all([
      db.from('materials').select('id, status').eq('project_id', input.projectId),
      db.from('concepts').select('id, name').eq('project_id', input.projectId),
      db.from('concept_mastery').select('concept_id, score, evidence_count, last_evidence_at').eq('project_id', input.projectId),
      db.from('quiz_attempts').select('completed_at, score').eq('project_id', input.projectId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1),
      db.from('recommendations').select('trigger_reason, concept_id, created_at').eq('project_id', input.projectId).eq('status', 'active'),
      db.from('learning_events').select('created_at').eq('project_id', input.projectId).order('created_at', { ascending: false }).limit(1),
    ]);

  const masteryByConcept = new Map<string, MasteryState>();
  for (const m of mastery ?? []) {
    masteryByConcept.set(m.concept_id as string, {
      score: Number(m.score),
      evidenceCount: Number(m.evidence_count),
      lastEvidenceAt: m.last_evidence_at ? new Date(m.last_evidence_at as string) : null,
    });
  }

  return {
    hasMaterials: (materials ?? []).length > 0,
    readyMaterials: (materials ?? []).filter((m) => m.status === 'ready').length,
    concepts: (concepts ?? []).map((c) => ({
      conceptId: c.id as string,
      name: c.name as string,
      mastery: masteryByConcept.get(c.id as string) ?? emptyMastery(),
    })),
    patterns: input.patterns,
    lastQuizAt: lastQuiz?.[0]?.completed_at ? new Date(lastQuiz[0].completed_at as string) : null,
    lastQuizScore: lastQuiz?.[0]?.score !== null && lastQuiz?.[0]?.score !== undefined ? Number(lastQuiz[0].score) : null,
    lastActivityAt: lastEvent?.[0]?.created_at ? new Date(lastEvent[0].created_at as string) : null,
    activeRecommendations: (active ?? []).map((r) => ({
      trigger: r.trigger_reason as never,
      conceptId: r.concept_id as string | null,
      createdAt: new Date(r.created_at as string),
    })),
  };
}

export { masteryBand };
