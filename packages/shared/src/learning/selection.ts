import {
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  PRIOR_MASTERY,
  expectedSuccess,
  masteryConfidence,
  type MasteryState,
} from './mastery.ts';

/**
 * Adaptive question selection. Deterministic — no AI, no I/O.
 *
 * The PRD rejects the obvious implementation outright: "The system should not
 * simply implement Wrong -> Easy, Correct -> Hard" (§9). It asks for selection
 * that weighs concepts, mastery, previous mistakes, recent performance,
 * difficulty and question history.
 *
 * So this scores every candidate concept on four independent signals and picks
 * the highest. The chosen difficulty is then derived from the mastery estimate
 * rather than from whether the last answer happened to be right.
 */

export type ConceptCandidate = {
  conceptId: string;
  name: string;
  mastery: MasteryState;
  /** Wrong answers on this concept within the recent window. */
  recentMistakes: number;
  /** How many questions on this concept have been asked, ever. */
  timesAsked: number;
  /** When it was last asked, for the repetition penalty. */
  lastAskedAt: Date | null;
};

export type SelectionWeights = {
  need: number;
  uncertainty: number;
  mistakes: number;
  repetition: number;
};

/**
 * Relative importance of each signal.
 *
 * `need` leads because practice should go where mastery is weakest. But it does
 * not dominate: without `uncertainty` the system would hammer one weak concept
 * and never establish what the learner knows elsewhere, and without
 * `repetition` it would ask about the same concept every single question.
 *
 * `mistakes` is deliberately the SMALLEST weight, which looks wrong until you
 * notice the double-counting: a wrong answer has already pushed mastery down
 * via updateMastery, so it is present in `need` too. Weighting mistakes as a
 * co-equal signal counts the same evidence twice — with `mistakes` at 0.8 a
 * concept at 0.65 mastery with three recent misses outranked one sitting at
 * 0.20, which is not the concept the learner needs most. Its real job is to
 * break ties toward what the learner is struggling with *right now*, since
 * mastery lags the most recent answers. Caught by a unit test (D-039).
 */
export const DEFAULT_WEIGHTS: SelectionWeights = {
  need: 1.0,
  uncertainty: 0.7,
  mistakes: 0.4,
  repetition: 0.9,
};

/** A concept asked this recently is strongly de-prioritised. */
const REPETITION_WINDOW_MINUTES = 30;

export type SelectionReason = {
  conceptId: string;
  name: string;
  score: number;
  signals: { need: number; uncertainty: number; mistakes: number; repetition: number };
};

export type Selection = {
  conceptId: string;
  name: string;
  difficulty: number;
  /** Why this concept won — surfaced so adaptivity is explainable, not magic. */
  reason: SelectionReason;
  /** Runners-up, for debugging and for the admin view. */
  alternatives: SelectionReason[];
};

/**
 * Scores one concept. Every signal is 0..1 before weighting, so the weights
 * mean what they look like they mean.
 */
export function scoreConcept(
  candidate: ConceptCandidate,
  now: Date,
  weights: SelectionWeights = DEFAULT_WEIGHTS,
): SelectionReason {
  const state = candidate.mastery;

  // 1. Need — how far below secure this concept sits.
  const need = 1 - state.score;

  // 2. Uncertainty — how little we actually know. A concept with no evidence is
  //    valuable to ask about even if its prior score looks fine, because the
  //    prior is a placeholder, not a measurement.
  const uncertainty = 1 - masteryConfidence(state, now);

  // 3. Mistakes — recent wrong answers, saturating so one bad session does not
  //    pin the learner to a single concept forever.
  const mistakes = Math.min(1, candidate.recentMistakes / 3);

  // 4. Repetition — asked recently, so push it down. Decays linearly to zero
  //    across the window; a concept never asked contributes nothing here.
  let repetition = 0;
  if (candidate.lastAskedAt) {
    const minutes = (now.getTime() - candidate.lastAskedAt.getTime()) / 60_000;
    repetition = Math.max(0, 1 - minutes / REPETITION_WINDOW_MINUTES);
  }

  const score =
    weights.need * need +
    weights.uncertainty * uncertainty +
    weights.mistakes * mistakes -
    weights.repetition * repetition;

  return {
    conceptId: candidate.conceptId,
    name: candidate.name,
    score: round4(score),
    signals: {
      need: round4(need),
      uncertainty: round4(uncertainty),
      mistakes: round4(mistakes),
      repetition: round4(repetition),
    },
  };
}

/**
 * Target success rate when choosing difficulty.
 *
 * 0.7, not 0.5. A question the learner has an even chance of getting wrong is
 * maximally informative for measurement, but demoralising as practice. Aiming
 * slightly inside their ability keeps the assessment useful while still being
 * a genuine test. This is the one place the design trades measurement precision
 * for the learner's experience, and it is deliberate.
 */
const TARGET_SUCCESS = 0.7;
const STEEPNESS = 6;

/**
 * Picks the difficulty at which this learner is expected to succeed about
 * TARGET_SUCCESS of the time.
 *
 * Derived from the mastery ESTIMATE, not from the last answer. That is the
 * substantive difference from "wrong -> easy, correct -> hard": a single
 * unlucky answer barely moves mastery (see mastery.ts), so it barely moves
 * difficulty either.
 */
export function selectDifficulty(state: MasteryState, now: Date = new Date()): number {
  // Invert the logistic: find the normalised difficulty giving TARGET_SUCCESS.
  const offset = Math.log(TARGET_SUCCESS / (1 - TARGET_SUCCESS)) / STEEPNESS;
  const targetNormalised = state.score - offset;

  const raw = MIN_DIFFICULTY + targetNormalised * (MAX_DIFFICULTY - MIN_DIFFICULTY);
  let difficulty = Math.round(raw);

  // With almost no evidence, avoid the extremes: an opening question at
  // difficulty 5 or 1 tells us little and reads badly either way.
  if (masteryConfidence(state, now) < 0.25) {
    difficulty = Math.min(4, Math.max(2, difficulty));
  }

  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
}

export function selectNextQuestion(
  candidates: ConceptCandidate[],
  now: Date = new Date(),
  weights: SelectionWeights = DEFAULT_WEIGHTS,
): Selection | null {
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({ candidate: c, reason: scoreConcept(c, now, weights) }))
    // Deterministic tie-break on conceptId: the same inputs must always produce
    // the same question, or the behaviour cannot be tested or explained.
    .sort((a, b) => b.reason.score - a.reason.score || a.candidate.conceptId.localeCompare(b.candidate.conceptId));

  const winner = scored[0]!;
  return {
    conceptId: winner.candidate.conceptId,
    name: winner.candidate.name,
    difficulty: selectDifficulty(winner.candidate.mastery, now),
    reason: winner.reason,
    alternatives: scored.slice(1, 4).map((s) => s.reason),
  };
}

/** Convenience for a concept with no mastery row yet. */
export function emptyMastery(): MasteryState {
  return { score: PRIOR_MASTERY, evidenceCount: 0, lastEvidenceAt: null };
}

/** Re-exported so callers can reason about selection without importing two modules. */
export { expectedSuccess };

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
