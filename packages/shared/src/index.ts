/**
 * @asc/shared — domain types, validation schemas, and the deterministic
 * learning core.
 *
 * Hard rule for this package: no network calls, no database access, no AI
 * providers. Everything here must be a pure function or a plain type, so the
 * learning logic the PRD asks to be deterministic (mastery scoring, adaptive
 * selection, repeated-mistake detection, recommendation triggers) can be unit
 * tested without mocking a provider. See CLAUDE.md "Engineering principles".
 */

export * from './schemas.ts';
export * from './learning/index.ts';
export * from './analytics/index.ts';

export const PACKAGE_NAME = '@asc/shared' as const;
