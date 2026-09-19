import { scoreConcept, type ConceptCandidate, type SelectionReason } from './selection.ts';

/**
 * Flashcard scheduling. Pure arithmetic — no AI, no I/O, no clock of its own.
 *
 * The PRD lists flashcards and spaced repetition as creative additions that
 * "should not compromise the core learning experience". The way to honour that
 * is to build them out of the same parts as the core rather than beside it:
 * which concepts get a deck comes from the quiz selector, and when a card comes
 * back is this file — an SM-2 derivative, deterministic and unit tested, for
 * exactly the reasons mastery scoring is (CLAUDE.md: deterministic backend
 * logic, not an AI call).
 *
 * What a model is asked for, and all it is asked for, is the wording on the two
 * faces of a card.
 */

/**
 * What the learner says about their own recall.
 *
 * Four ratings rather than a right/wrong flag because recall is not binary:
 * "I knew it but it took a while" and "I had no idea" should not produce the
 * same interval. These are the SM-2 grades, named rather than numbered so the
 * API contract reads as what it means.
 */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export const REVIEW_RATINGS: readonly ReviewRating[] = ['again', 'hard', 'good', 'easy'] as const;

export type CardSchedule = {
  /** Days until the next review. 0 while a card is still in the learning step. */
  intervalDays: number;
  /** SM-2 ease factor — how fast intervals grow for this particular card. */
  ease: number;
  /** Consecutive successful reviews. Reset by a lapse. */
  reps: number;
  /** How many times this card has been forgotten after being learned. */
  lapses: number;
  dueAt: Date;
};

export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
export const DEFAULT_EASE = 2.5;

/**
 * A forgotten card comes back inside the same sitting, not tomorrow.
 *
 * The point of rating "again" is that you did not know it; making the learner
 * wait a day to see it a second time is the one thing spaced repetition is
 * supposed to prevent.
 */
export const RELEARN_MINUTES = 10;

/**
 * Longest interval this system will schedule.
 *
 * SM-2 will happily produce a four-year gap, which is meaningless for a
 * learner studying one course from one set of uploads. Capped so the deck
 * stays a study tool rather than an archive.
 */
export const MAX_INTERVAL_DAYS = 180;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const clampEase = (ease: number): number => Math.min(MAX_EASE, Math.max(MIN_EASE, ease));

/** Stored as numeric(6,2), so the value the algorithm returns is the value the column holds. */
const roundDays = (days: number): number =>
  Math.min(MAX_INTERVAL_DAYS, Math.round(days * 100) / 100);

/** State for a card that has never been reviewed: due immediately. */
export function newCardSchedule(now: Date): CardSchedule {
  return { intervalDays: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0, dueAt: new Date(now.getTime()) };
}

/**
 * Applies one review to a card's schedule.
 *
 * Returns a new schedule; never mutates the input. `now` is a parameter rather
 * than a `new Date()` inside, so a test can review a card across six months in
 * a millisecond and the result is reproducible.
 *
 * The ease adjustments are the SM-2 ones, minus its quality-to-ease polynomial:
 * with four grades instead of six, a flat step per grade is the same shape and
 * is explainable to a learner in one sentence.
 */
export function reviewCard(schedule: CardSchedule, rating: ReviewRating, now: Date): CardSchedule {
  const ease = schedule.ease;
  const reps = schedule.reps;

  if (rating === 'again') {
    // A lapse costs ease and resets the streak, but never the card's history:
    // `lapses` is what tells the learner (and the deck) that this one is hard.
    return {
      intervalDays: 0,
      ease: clampEase(ease - 0.2),
      reps: 0,
      lapses: schedule.lapses + 1,
      dueAt: new Date(now.getTime() + RELEARN_MINUTES * MS_PER_MINUTE),
    };
  }

  let nextEase = ease;
  let intervalDays: number;

  if (rating === 'hard') {
    nextEase = clampEase(ease - 0.15);
    // Growth, but slower than ease would give — and never a shrinking interval,
    // which would punish a learner for admitting a card was hard.
    intervalDays = reps === 0 ? 1 : Math.max(schedule.intervalDays * 1.2, schedule.intervalDays + 1);
  } else if (rating === 'good') {
    // The two fixed learning steps. Multiplying from 0 would leave the card at
    // 0 forever, so the first two successes are stated rather than computed.
    intervalDays = reps === 0 ? 1 : reps === 1 ? 3 : schedule.intervalDays * ease;
  } else {
    nextEase = clampEase(ease + 0.15);
    intervalDays = reps === 0 ? 3 : schedule.intervalDays * ease * 1.3;
  }

  const capped = roundDays(intervalDays);
  return {
    intervalDays: capped,
    ease: Math.round(nextEase * 100) / 100,
    reps: reps + 1,
    lapses: schedule.lapses,
    dueAt: new Date(now.getTime() + capped * MS_PER_DAY),
  };
}

export type ReviewableCard = { id: string; dueAt: Date };

/**
 * The cards to show now, soonest due first.
 *
 * Ordering by due date rather than by creation means an overdue card from last
 * week comes before one that became due an hour ago — the learner sees what
 * they are closest to losing.
 */
export function dueCards<T extends ReviewableCard>(cards: T[], now: Date, limit?: number): T[] {
  const due = cards
    .filter((c) => c.dueAt.getTime() <= now.getTime())
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return typeof limit === 'number' ? due.slice(0, limit) : due;
}

/** When the next card becomes due, for a deck with nothing due right now. */
export function nextDueAt<T extends ReviewableCard>(cards: T[], now: Date): Date | null {
  const upcoming = cards
    .filter((c) => c.dueAt.getTime() > now.getTime())
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return upcoming[0]?.dueAt ?? null;
}

/**
 * Which concepts a new deck should cover.
 *
 * Deliberately `scoreConcept` — the same function that chooses the next quiz
 * question — rather than a second ranking that could disagree with it. A deck
 * generated for the concepts the quiz considers weakest is a deck about the
 * same weaknesses the rest of the system is already talking about.
 *
 * The one difference is that cards are asked for in a batch, so this returns
 * the top `count` instead of a single winner.
 */
export function selectDeckConcepts(
  candidates: ConceptCandidate[],
  now: Date,
  count: number,
): SelectionReason[] {
  return candidates
    .map((c) => scoreConcept(c, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, count));
}
