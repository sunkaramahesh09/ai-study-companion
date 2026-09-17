import { describe, expect, it } from 'vitest';
import { allTriggers, evaluateTriggers, type ProjectSnapshot } from './recommend.ts';
import type { MistakePattern } from './mistakes.ts';
import type { MasteryState } from './mastery.ts';

const T0 = new Date('2026-09-17T10:00:00Z');
const daysAgo = (n: number) => new Date(T0.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(T0.getTime() - n * 3_600_000);

const mastery = (score: number, evidenceCount = 5): MasteryState => ({
  score,
  evidenceCount,
  lastEvidenceAt: daysAgo(1),
});

const pattern = (over: Partial<MistakePattern> = {}): MistakePattern => ({
  conceptId: 'c1',
  conceptName: 'Gradient descent',
  mistakes: 3,
  attempts: 4,
  errorRate: 0.75,
  recovered: false,
  meanDifficulty: 2,
  severity: 'blocked',
  lastMistakeAt: daysAgo(1),
  ...over,
});

const snapshot = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  hasMaterials: true,
  readyMaterials: 1,
  concepts: [],
  patterns: [],
  lastQuizAt: daysAgo(1),
  lastActivityAt: daysAgo(1),
  activeRecommendations: [],
  ...over,
});

describe('evaluateTriggers', () => {
  it('asks for material first when the project is empty', () => {
    // Everything else is meaningless without something to learn from.
    const t = evaluateTriggers(snapshot({ hasMaterials: false, readyMaterials: 0 }), T0);
    expect(t).toMatchObject({ trigger: 'material_ready', action: 'upload_material' });
  });

  it('prioritises an unrecovered repeated mistake above all else', () => {
    const t = evaluateTriggers(
      snapshot({ patterns: [pattern()], concepts: [{ conceptId: 'c2', name: 'Other', mastery: mastery(0.1) }] }),
      T0,
    );
    expect(t!.trigger).toBe('repeated_mistake');
    expect(t!.conceptId).toBe('c1');
  });

  it('suggests REVIEW for a repeated mistake, not another quiz', () => {
    // Re-testing a concept they keep missing measures the gap again instead of
    // closing it.
    expect(evaluateTriggers(snapshot({ patterns: [pattern()] }), T0)!.action).toBe('review_material');
  });

  it('ignores a recovered pattern', () => {
    const t = evaluateTriggers(snapshot({ patterns: [pattern({ recovered: true })] }), T0);
    expect(t?.trigger).not.toBe('repeated_mistake');
  });

  it('returns null rather than inventing a recommendation', () => {
    // A quiet project that was active yesterday and has nothing weak does not
    // need advice. Manufacturing one would train the learner to ignore them.
    const t = evaluateTriggers(snapshot({ concepts: [], patterns: [] }), T0);
    expect(t).toBeNull();
  });

  it('flags a weak concept once there is enough evidence', () => {
    const t = evaluateTriggers(
      snapshot({ concepts: [{ conceptId: 'c9', name: 'Backprop', mastery: mastery(0.25, 6) }] }),
      T0,
    );
    expect(t).toMatchObject({ trigger: 'weak_concept', conceptId: 'c9', action: 'ask_tutor' });
  });

  it('does NOT flag a weak-looking concept backed by one answer', () => {
    // A single wrong answer is not evidence of a weakness worth acting on.
    const t = evaluateTriggers(
      snapshot({ concepts: [{ conceptId: 'c9', name: 'Backprop', mastery: mastery(0.2, 1) }] }),
      T0,
    );
    expect(t!.trigger).not.toBe('weak_concept');
  });

  it('picks the weakest concept when several qualify', () => {
    const t = evaluateTriggers(
      snapshot({
        concepts: [
          { conceptId: 'mid', name: 'Mid', mastery: mastery(0.42, 6) },
          { conceptId: 'worst', name: 'Worst', mastery: mastery(0.15, 6) },
        ],
      }),
      T0,
    );
    expect(t!.conceptId).toBe('worst');
  });

  it('suggests a first quiz when material is indexed but never tested', () => {
    // Without a quiz there is no evidence, so mastery has nothing to work with.
    const t = evaluateTriggers(snapshot({ lastQuizAt: null, readyMaterials: 2 }), T0);
    expect(t).toMatchObject({ trigger: 'material_ready', action: 'take_quiz' });
  });

  it('nudges a dormant project', () => {
    const t = evaluateTriggers(
      snapshot({ lastActivityAt: daysAgo(9), lastQuizAt: daysAgo(9), concepts: [] }),
      T0,
    );
    expect(t!.trigger).toBe('stale_project');
    expect(t!.evidence.idleDays).toBe(9);
  });

  it('does not call a project stale after a day', () => {
    const triggers = allTriggers(snapshot({ lastActivityAt: daysAgo(1) }), T0);
    expect(triggers.map((t) => t.trigger)).not.toContain('stale_project');
  });

  it('suggests continuing when everything looks healthy', () => {
    const t = evaluateTriggers(
      snapshot({ concepts: [{ conceptId: 'c1', name: 'Fine', mastery: mastery(0.85, 8) }] }),
      T0,
    );
    expect(t).toMatchObject({ trigger: 'quiz_completed', action: 'take_quiz' });
  });

  it('returns exactly one recommendation, not a list', () => {
    // The PRD's question is "what should I do next?", singular. Five competing
    // suggestions answer a different and less useful question.
    const t = evaluateTriggers(
      snapshot({
        patterns: [pattern()],
        concepts: [{ conceptId: 'c2', name: 'Weak', mastery: mastery(0.2, 6) }],
        lastQuizAt: null,
      }),
      T0,
    );
    expect(t).not.toBeNull();
    expect(Array.isArray(t)).toBe(false);
  });
});

describe('cooldown', () => {
  it('suppresses a trigger already raised recently for the same concept', () => {
    const t = evaluateTriggers(
      snapshot({
        patterns: [pattern()],
        activeRecommendations: [{ trigger: 'repeated_mistake', conceptId: 'c1', createdAt: hoursAgo(2) }],
      }),
      T0,
    );
    // Suppressed, and nothing else qualifies, so no recommendation at all.
    expect(t?.trigger).not.toBe('repeated_mistake');
  });

  it('allows the same trigger for a DIFFERENT concept', () => {
    const t = evaluateTriggers(
      snapshot({
        patterns: [pattern({ conceptId: 'c2', conceptName: 'Other' })],
        activeRecommendations: [{ trigger: 'repeated_mistake', conceptId: 'c1', createdAt: hoursAgo(2) }],
      }),
      T0,
    );
    expect(t).toMatchObject({ trigger: 'repeated_mistake', conceptId: 'c2' });
  });

  it('allows a trigger again once the cooldown has passed', () => {
    const t = evaluateTriggers(
      snapshot({
        patterns: [pattern()],
        activeRecommendations: [{ trigger: 'repeated_mistake', conceptId: 'c1', createdAt: hoursAgo(20) }],
      }),
      T0,
    );
    expect(t!.trigger).toBe('repeated_mistake');
  });

  it('falls through to the next rule rather than going silent', () => {
    const t = evaluateTriggers(
      snapshot({
        patterns: [pattern()],
        concepts: [{ conceptId: 'c5', name: 'Weak', mastery: mastery(0.2, 6) }],
        activeRecommendations: [{ trigger: 'repeated_mistake', conceptId: 'c1', createdAt: hoursAgo(1) }],
      }),
      T0,
    );
    expect(t).toMatchObject({ trigger: 'weak_concept', conceptId: 'c5' });
  });
});

describe('explainability', () => {
  it('carries machine-readable evidence for the generated sentence and for evals', () => {
    // A recommendation must be explainable by the state that produced it.
    const t = evaluateTriggers(snapshot({ patterns: [pattern()] }), T0);
    expect(t!.evidence).toMatchObject({
      mistakes: 3,
      attempts: 4,
      errorRate: 0.75,
      severity: 'blocked',
      concept: 'Gradient descent',
    });
  });

  it('is deterministic for the same snapshot', () => {
    const s = snapshot({ concepts: [{ conceptId: 'c1', name: 'X', mastery: mastery(0.2, 6) }] });
    expect(evaluateTriggers(s, T0)).toEqual(evaluateTriggers(s, T0));
  });
});
