/**
 * The deterministic learning core.
 *
 * Everything in here is a pure function: no AI calls, no database, no clock
 * except one passed in. That is a stated PRD evaluation criterion — mastery
 * scoring, adaptive selection, repeated-mistake detection and recommendation
 * triggers must be backend logic rather than a model's opinion (CLAUDE.md,
 * PRD §9/§10/§13).
 *
 * The practical payoff is that this behaviour is testable without mocking a
 * provider, reproducible for the same inputs, explainable to the learner, and
 * free to run.
 */
export * from './mastery.ts';
export * from './selection.ts';
export * from './mistakes.ts';
export * from './recommend.ts';
export * from './growth.ts';
export * from './facts.ts';
export * from './progress.ts';
