import {
  detectRepeatedMistakes,
  emptyMastery,
  selectNextQuestion,
  updateMastery,
  type AnswerRecord,
  type ConceptCandidate,
  type MasteryState,
} from '@asc/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from './supabase.ts';

/**
 * Assembles the state the deterministic selector needs, then applies its
 * decision.
 *
 * This module is the seam between the pure learning core (`@asc/shared`, task
 * 14) and the database. The core stays free of I/O so it can be tested without
 * mocks; everything that touches Postgres lives here.
 */

const RECENT_WINDOW_DAYS = 14;

export type ConceptRow = { id: string; name: string };

/**
 * Builds selector candidates for every concept in the project.
 *
 * Concepts with no mastery row yet are included with an empty state, not
 * skipped. A concept nobody has been tested on is exactly the one worth asking
 * about — skipping them would make the quiz orbit the concepts it already knows
 * about.
 */
export async function buildCandidates(
  db: SupabaseClient,
  projectId: string,
  now: Date,
): Promise<ConceptCandidate[]> {
  const [{ data: concepts }, { data: mastery }, { data: answers }] = await Promise.all([
    db.from('concepts').select('id, name').eq('project_id', projectId),
    db.from('concept_mastery').select('concept_id, score, evidence_count, last_evidence_at').eq('project_id', projectId),
    db
      .from('quiz_questions')
      .select('concept_id, is_correct, difficulty, answered_at')
      .eq('project_id', projectId)
      .not('answered_at', 'is', null)
      .order('answered_at', { ascending: false })
      .limit(200),
  ]);

  if (!concepts || concepts.length === 0) return [];

  const masteryByConcept = new Map<string, MasteryState>();
  for (const m of mastery ?? []) {
    masteryByConcept.set(m.concept_id as string, {
      score: Number(m.score),
      evidenceCount: Number(m.evidence_count),
      lastEvidenceAt: m.last_evidence_at ? new Date(m.last_evidence_at as string) : null,
    });
  }

  const cutoff = now.getTime() - RECENT_WINDOW_DAYS * 86_400_000;
  const mistakes = new Map<string, number>();
  const lastAsked = new Map<string, Date>();

  for (const a of answers ?? []) {
    const conceptId = a.concept_id as string | null;
    if (!conceptId) continue;
    const at = new Date(a.answered_at as string);
    if (!lastAsked.has(conceptId)) lastAsked.set(conceptId, at);
    if (!a.is_correct && at.getTime() >= cutoff) {
      mistakes.set(conceptId, (mistakes.get(conceptId) ?? 0) + 1);
    }
  }

  return concepts.map((c) => ({
    conceptId: c.id as string,
    name: c.name as string,
    mastery: masteryByConcept.get(c.id as string) ?? emptyMastery(),
    recentMistakes: mistakes.get(c.id as string) ?? 0,
    timesAsked: 0,
    lastAskedAt: lastAsked.get(c.id as string) ?? null,
  }));
}

export type NextSelection = {
  conceptId: string;
  conceptName: string;
  difficulty: number;
  reason: unknown;
};

/**
 * Chooses the next concept and difficulty.
 *
 * Concepts already covered in THIS attempt are pushed down by pretending they
 * were just asked, so one quiz spreads across the material instead of drilling
 * a single concept — without needing a second code path in the selector.
 */
export async function chooseNext(
  db: SupabaseClient,
  projectId: string,
  askedConceptIds: string[],
  now: Date = new Date(),
): Promise<NextSelection | null> {
  const candidates = await buildCandidates(db, projectId, now);
  if (candidates.length === 0) return null;

  const asked = new Set(askedConceptIds);
  const adjusted = candidates.map((c) =>
    asked.has(c.conceptId) ? { ...c, lastAskedAt: now } : c,
  );

  const selection = selectNextQuestion(adjusted, now);
  if (!selection) return null;

  return {
    conceptId: selection.conceptId,
    conceptName: selection.name,
    difficulty: selection.difficulty,
    reason: { ...selection.reason, alternatives: selection.alternatives },
  };
}

export type MasteryApplication = {
  conceptId: string;
  before: number;
  after: number;
  delta: number;
  evidenceCount: number;
};

/**
 * Applies one answer to a concept's mastery.
 *
 * The arithmetic is `updateMastery` from the pure core; this only reads the
 * current row, writes the new one, and appends to `mastery_history` so Growth
 * Analysis can be recomputed from evidence rather than from a stored trend.
 *
 * Reads go through the caller's RLS-scoped client; WRITES go through the
 * service role, because `concept_mastery` and `mastery_history` are SELECT-only
 * for `authenticated` (migration 0006). A learner who could write their own
 * mastery could simply declare themselves expert. Ownership comes from the
 * verified request context.
 */
export async function applyMastery(
  db: SupabaseClient,
  params: {
    projectId: string;
    userId: string;
    conceptId: string;
    correctness: number;
    difficulty: number;
    answeredAt: Date;
    sourceId: string;
    reason?: 'quiz_answer' | 'quiz_completed' | 'recompute';
  },
): Promise<MasteryApplication> {
  const { data: existing } = await db
    .from('concept_mastery')
    .select('id, score, evidence_count, last_evidence_at')
    .eq('concept_id', params.conceptId)
    .maybeSingle();

  const before: MasteryState = existing
    ? {
        score: Number(existing.score),
        evidenceCount: Number(existing.evidence_count),
        lastEvidenceAt: existing.last_evidence_at ? new Date(existing.last_evidence_at as string) : null,
      }
    : emptyMastery();

  const update = updateMastery(
    before,
    { correctness: params.correctness, difficulty: params.difficulty, answeredAt: params.answeredAt },
    params.answeredAt,
  );

  const write = serviceClient();
  await write.from('concept_mastery').upsert(
    {
      concept_id: params.conceptId,
      project_id: params.projectId,
      user_id: params.userId,
      score: update.score,
      evidence_count: update.evidenceCount,
      last_evidence_at: params.answeredAt.toISOString(),
    },
    { onConflict: 'concept_id' },
  );

  await write.from('mastery_history').insert({
    concept_id: params.conceptId,
    project_id: params.projectId,
    user_id: params.userId,
    score_before: before.score,
    score_after: update.score,
    reason: params.reason ?? 'quiz_answer',
    source_id: params.sourceId,
  });

  return {
    conceptId: params.conceptId,
    before: before.score,
    after: update.score,
    delta: update.delta,
    evidenceCount: update.evidenceCount,
  };
}

/** Recent answers for this project, shaped for repeated-mistake detection. */
export async function recentAnswers(
  db: SupabaseClient,
  projectId: string,
  limit = 100,
): Promise<AnswerRecord[]> {
  const { data } = await db
    .from('quiz_questions')
    .select('concept_id, is_correct, difficulty, answered_at, concepts(name)')
    .eq('project_id', projectId)
    .not('answered_at', 'is', null)
    .order('answered_at', { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => ({
    conceptId: row.concept_id as string | null,
    conceptName: (row.concepts as { name?: string } | null)?.name ?? 'Concept',
    isCorrect: Boolean(row.is_correct),
    difficulty: Number(row.difficulty),
    answeredAt: new Date(row.answered_at as string),
  }));
}

export { detectRepeatedMistakes };
