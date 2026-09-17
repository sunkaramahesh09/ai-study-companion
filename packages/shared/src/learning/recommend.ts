import type { MistakePattern } from './mistakes.ts';
import { masteryBand, type MasteryState } from './mastery.ts';

/**
 * Recommendation TRIGGERS. Deterministic — no AI, no I/O.
 *
 * The PRD requires that deciding *when* to recommend is backend logic, not an
 * AI call. Only the sentence shown to the learner is generated, and it is
 * generated from the trigger decided here — so a recommendation is always
 * explainable by the state that produced it, and the evaluation suite can check
 * that the text matches that state.
 */

export type TriggerReason =
  | 'repeated_mistake'
  | 'weak_concept'
  | 'quiz_completed'
  | 'material_ready'
  | 'stale_project';

export type ActionType = 'review_material' | 'take_quiz' | 'ask_tutor' | 'upload_material';

export type ConceptSnapshot = {
  conceptId: string;
  name: string;
  mastery: MasteryState;
};

export type ProjectSnapshot = {
  hasMaterials: boolean;
  readyMaterials: number;
  concepts: ConceptSnapshot[];
  patterns: MistakePattern[];
  lastQuizAt: Date | null;
  lastActivityAt: Date | null;
  /** Active recommendations already shown, to avoid repeating ourselves. */
  activeRecommendations: { trigger: TriggerReason; conceptId: string | null; createdAt: Date }[];
};

export type RecommendationTrigger = {
  trigger: TriggerReason;
  conceptId: string | null;
  conceptName: string | null;
  action: ActionType;
  /** Ordering hint when several rules fire. */
  priority: number;
  /** Machine-readable justification, for the generated sentence and for evals. */
  evidence: Record<string, string | number | boolean>;
};

/** Do not re-raise the same trigger for the same concept inside this window. */
const COOLDOWN_HOURS = 12;
const STALE_PROJECT_DAYS = 5;

/**
 * Decides whether to recommend anything, and what.
 *
 * Rules are evaluated in priority order and the first match wins. One
 * recommendation at a time is deliberate: the PRD's question is "what should I
 * do next?" (§10), singular. A list of five competing suggestions answers a
 * different, less useful question.
 */
export function evaluateTriggers(
  snapshot: ProjectSnapshot,
  now: Date = new Date(),
): RecommendationTrigger | null {
  for (const candidate of allTriggers(snapshot, now)) {
    if (!onCooldown(snapshot, candidate, now)) return candidate;
  }
  return null;
}

/** Every rule that currently fires, highest priority first. Exposed for tests. */
export function allTriggers(snapshot: ProjectSnapshot, now: Date = new Date()): RecommendationTrigger[] {
  const out: RecommendationTrigger[] = [];

  // 1. Nothing to learn from yet. Everything else is meaningless without it.
  if (!snapshot.hasMaterials) {
    return [
      {
        trigger: 'material_ready',
        conceptId: null,
        conceptName: null,
        action: 'upload_material',
        priority: 100,
        evidence: { hasMaterials: false },
      },
    ];
  }

  // 2. An unrecovered repeated mistake is the strongest signal available.
  const worst = snapshot.patterns.find((p) => !p.recovered);
  if (worst) {
    out.push({
      trigger: 'repeated_mistake',
      conceptId: worst.conceptId,
      conceptName: worst.conceptName,
      // Review before re-testing: another quiz on a concept they keep missing
      // measures the same gap again instead of closing it.
      action: 'review_material',
      priority: 90,
      evidence: {
        mistakes: worst.mistakes,
        attempts: worst.attempts,
        errorRate: worst.errorRate,
        severity: worst.severity,
        concept: worst.conceptName,
      },
    });
  }

  // 3. A concept that is measurably weak, with enough evidence to say so.
  const weak = snapshot.concepts
    .filter((c) => masteryBand(c.mastery, now) === 'needs_work' && c.mastery.evidenceCount >= 2)
    .sort((a, b) => a.mastery.score - b.mastery.score || a.conceptId.localeCompare(b.conceptId))[0];
  if (weak) {
    out.push({
      trigger: 'weak_concept',
      conceptId: weak.conceptId,
      conceptName: weak.name,
      action: 'ask_tutor',
      priority: 70,
      evidence: {
        concept: weak.name,
        mastery: weak.mastery.score,
        evidence: weak.mastery.evidenceCount,
      },
    });
  }

  // 4. Material is indexed but never tested. Without a quiz there is no
  //    evidence, so the whole mastery system has nothing to work with.
  if (snapshot.readyMaterials > 0 && !snapshot.lastQuizAt) {
    out.push({
      trigger: 'material_ready',
      conceptId: null,
      conceptName: null,
      action: 'take_quiz',
      priority: 60,
      evidence: { readyMaterials: snapshot.readyMaterials, everQuizzed: false },
    });
  }

  // 5. Quizzed before, and everything currently looks fine — keep going.
  if (snapshot.lastQuizAt && snapshot.concepts.some((c) => c.mastery.evidenceCount > 0)) {
    out.push({
      trigger: 'quiz_completed',
      conceptId: null,
      conceptName: null,
      action: 'take_quiz',
      priority: 30,
      evidence: { concepts: snapshot.concepts.length },
    });
  }

  // 6. Dormant project with material sitting in it.
  const idleDays = snapshot.lastActivityAt
    ? (now.getTime() - snapshot.lastActivityAt.getTime()) / 86_400_000
    : Infinity;
  if (idleDays >= STALE_PROJECT_DAYS && snapshot.readyMaterials > 0) {
    out.push({
      trigger: 'stale_project',
      conceptId: null,
      conceptName: null,
      action: 'review_material',
      priority: 40,
      evidence: { idleDays: Math.floor(idleDays) },
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

function onCooldown(snapshot: ProjectSnapshot, candidate: RecommendationTrigger, now: Date): boolean {
  const cutoff = now.getTime() - COOLDOWN_HOURS * 3_600_000;
  return snapshot.activeRecommendations.some(
    (r) =>
      r.trigger === candidate.trigger &&
      r.conceptId === candidate.conceptId &&
      r.createdAt.getTime() > cutoff,
  );
}
