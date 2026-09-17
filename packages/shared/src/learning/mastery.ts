/**
 * Mastery estimation. Pure arithmetic — no AI, no I/O.
 *
 * The PRD is explicit that mastery is "an estimate, not a claim of perfect
 * measurement" (§10) and that this calculation must be deterministic backend
 * logic rather than an AI call. Asking a model for a score would be
 * unrepeatable, unexplainable and untestable; this is all three.
 *
 * The model is a simplified IRT / Elo update: a learner has a latent ability, a
 * question has a difficulty, and the estimate moves by the SURPRISE in the
 * outcome. Getting a hard question right when the estimate said you probably
 * would not moves it a long way; getting an easy one right when you were
 * expected to moves it barely at all. That property is what the PRD is really
 * asking for when it rejects "wrong -> easy, correct -> hard" (§9).
 */

/** Difficulty is 1..5 in the database; normalised to 0..1 for the maths. */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;

export function normaliseDifficulty(difficulty: number): number {
  const clamped = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
  return (clamped - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
}

/**
 * How sharply expected success falls away as difficulty passes ability.
 *
 * 6 means a learner at mastery 0.5 facing difficulty 0.5 has a 50% expected
 * success rate, while a half-scale mismatch sits near 95%/5%. Lower makes the
 * curve mushy and the update insensitive; much higher lets a single answer
 * swing the estimate wildly.
 */
const STEEPNESS = 6;

/** Probability a learner at `mastery` answers a question at `difficulty` correctly. */
export function expectedSuccess(mastery: number, normalisedDifficulty: number): number {
  return 1 / (1 + Math.exp(-(mastery - normalisedDifficulty) * STEEPNESS));
}

/**
 * Starting estimate for a concept with no evidence.
 *
 * 0.5, not 0. Zero would assert the learner knows nothing — a claim the system
 * has no evidence for — and would render every newly extracted concept
 * "critical" in the UI. 0.5 states honestly that we do not know yet, and
 * `evidenceCount` carries the confidence separately.
 */
export const PRIOR_MASTERY = 0.5;

export type MasteryState = {
  score: number;
  evidenceCount: number;
  lastEvidenceAt: Date | null;
};

export type AnswerEvidence = {
  /** 0..1. Binary for MCQ; open-ended grading produces partial credit. */
  correctness: number;
  /** 1..5 as stored. */
  difficulty: number;
  answeredAt: Date;
};

export type MasteryUpdate = {
  score: number;
  evidenceCount: number;
  /** Signed change applied to the score. */
  delta: number;
  /** What the model predicted before seeing the outcome. */
  expected: number;
  /** Effective learning rate used, after confidence and staleness. */
  rate: number;
};

/** First answer moves the estimate a lot; the twentieth barely nudges it. */
const BASE_RATE = 0.35;
const CONFIDENCE_DAMPENING = 0.18;

/**
 * Evidence older than this counts for less when deciding how much a new answer
 * should move the estimate.
 *
 * Deliberately NOT a decay applied to the score itself. Drifting a learner's
 * mastery downward while they are away would invent evidence of forgetting that
 * the system never observed. Stale evidence instead lowers confidence, so the
 * system becomes more willing to update — the honest version of the same
 * intuition. Staleness is exposed separately for growth and recommendations.
 * See D-038.
 */
const STALENESS_HALF_LIFE_DAYS = 21;

export function effectiveEvidence(state: MasteryState, now: Date): number {
  if (state.evidenceCount === 0 || !state.lastEvidenceAt) return 0;
  const days = (now.getTime() - state.lastEvidenceAt.getTime()) / 86_400_000;
  if (days <= 0) return state.evidenceCount;
  return state.evidenceCount * 0.5 ** (days / STALENESS_HALF_LIFE_DAYS);
}

export function updateMastery(
  state: MasteryState,
  evidence: AnswerEvidence,
  now: Date = evidence.answeredAt,
): MasteryUpdate {
  const correctness = clamp01(evidence.correctness);
  const difficulty = normaliseDifficulty(evidence.difficulty);
  const expected = expectedSuccess(state.score, difficulty);

  // Confidence grows with evidence, so the estimate settles rather than
  // oscillating on every answer.
  const rate = BASE_RATE / (1 + effectiveEvidence(state, now) * CONFIDENCE_DAMPENING);

  // The whole model in one line: move by the surprise.
  const score = clamp01(state.score + rate * (correctness - expected));

  return {
    score: round4(score),
    evidenceCount: state.evidenceCount + 1,
    delta: round4(score - state.score),
    expected: round4(expected),
    rate: round4(rate),
  };
}

/** Applies a sequence of answers in order. Used by tests and by recomputation. */
export function replayMastery(evidence: AnswerEvidence[], initial?: MasteryState): MasteryState {
  let state: MasteryState = initial ?? { score: PRIOR_MASTERY, evidenceCount: 0, lastEvidenceAt: null };
  for (const e of evidence) {
    const next = updateMastery(state, e, e.answeredAt);
    state = { score: next.score, evidenceCount: next.evidenceCount, lastEvidenceAt: e.answeredAt };
  }
  return state;
}

/**
 * How much the estimate should be trusted, 0..1.
 *
 * Surfaced so the UI can distinguish "72% from one answer" from "72% from
 * fifteen". The PRD calls mastery an estimate; a bare percentage with no
 * confidence implies precision the system does not have.
 */
export function masteryConfidence(state: MasteryState, now: Date = new Date()): number {
  return round4(1 - 1 / (1 + effectiveEvidence(state, now) * 0.4));
}

export type MasteryBand = 'unassessed' | 'needs_work' | 'developing' | 'secure';

export function masteryBand(state: MasteryState, now: Date = new Date()): MasteryBand {
  if (state.evidenceCount === 0) return 'unassessed';
  // One answer is not enough to call something secure, however it went.
  if (masteryConfidence(state, now) < 0.3) return state.score < 0.4 ? 'needs_work' : 'developing';
  if (state.score >= 0.75) return 'secure';
  if (state.score < 0.45) return 'needs_work';
  return 'developing';
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
