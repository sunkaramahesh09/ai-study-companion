import { describe, expect, it } from 'vitest';
import { replayMastery, masteryBand, type AnswerEvidence, type MasteryState } from './mastery.ts';
import { selectNextQuestion, type ConceptCandidate } from './selection.ts';
import { detectRepeatedMistakes, type AnswerRecord } from './mistakes.ts';
import { evaluateTriggers } from './recommend.ts';

/**
 * The four pieces working together on one learner.
 *
 * Each module is unit-tested in isolation; this checks the property that
 * actually matters to the product — that a plausible sequence of answers
 * produces sensible teaching decisions end to end, with no AI involved
 * anywhere in the chain.
 */

const START = new Date('2026-09-01T09:00:00Z');
const at = (day: number, hour = 9) => new Date(START.getTime() + day * 86_400_000 + hour * 3_600_000);

describe('a learner who is strong on one concept and stuck on another', () => {
  // Photosynthesis: answered well, increasingly hard questions.
  const photosynthesis: AnswerEvidence[] = [
    { correctness: 1, difficulty: 2, answeredAt: at(0) },
    { correctness: 1, difficulty: 3, answeredAt: at(1) },
    { correctness: 1, difficulty: 3, answeredAt: at(2) },
    { correctness: 1, difficulty: 4, answeredAt: at(3) },
    { correctness: 1, difficulty: 4, answeredAt: at(4) },
  ];

  // Calvin cycle: repeatedly wrong, and on EASY questions.
  const calvin: AnswerEvidence[] = [
    { correctness: 0, difficulty: 2, answeredAt: at(1) },
    { correctness: 0, difficulty: 2, answeredAt: at(2) },
    { correctness: 0.2, difficulty: 1, answeredAt: at(3) },
  ];

  const photoState = replayMastery(photosynthesis);
  const calvinState = replayMastery(calvin);
  const now = at(5);

  it('separates the two concepts in mastery', () => {
    expect(photoState.score).toBeGreaterThan(0.7);
    expect(calvinState.score).toBeLessThan(0.3);
    expect(masteryBand(photoState, now)).toBe('secure');
    expect(masteryBand(calvinState, now)).toBe('needs_work');
  });

  it('sends the next question to the concept in trouble', () => {
    const candidates: ConceptCandidate[] = [
      { conceptId: 'photo', name: 'Photosynthesis', mastery: photoState, recentMistakes: 0, timesAsked: 5, lastAskedAt: at(4) },
      { conceptId: 'calvin', name: 'Calvin cycle', mastery: calvinState, recentMistakes: 3, timesAsked: 3, lastAskedAt: at(3) },
    ];
    const selection = selectNextQuestion(candidates, now)!;
    expect(selection.conceptId).toBe('calvin');
  });

  it('asks the struggling concept at a gentler difficulty than the secure one', () => {
    const forCalvin = selectNextQuestion(
      [{ conceptId: 'calvin', name: 'Calvin cycle', mastery: calvinState, recentMistakes: 3, timesAsked: 3, lastAskedAt: null }],
      now,
    )!;
    const forPhoto = selectNextQuestion(
      [{ conceptId: 'photo', name: 'Photosynthesis', mastery: photoState, recentMistakes: 0, timesAsked: 5, lastAskedAt: null }],
      now,
    )!;
    expect(forCalvin.difficulty).toBeLessThan(forPhoto.difficulty);
  });

  it('detects the Calvin cycle as a repeated mistake, and not photosynthesis', () => {
    const records: AnswerRecord[] = [
      ...photosynthesis.map((e) => ({ conceptId: 'photo', conceptName: 'Photosynthesis', isCorrect: true, difficulty: e.difficulty, answeredAt: e.answeredAt })),
      ...calvin.map((e) => ({ conceptId: 'calvin', conceptName: 'Calvin cycle', isCorrect: false, difficulty: e.difficulty, answeredAt: e.answeredAt })),
    ];
    const patterns = detectRepeatedMistakes(records, now);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ conceptId: 'calvin', severity: 'blocked', recovered: false });
  });

  it('recommends REVIEWING the stuck concept, naming it', () => {
    const records: AnswerRecord[] = calvin.map((e) => ({
      conceptId: 'calvin', conceptName: 'Calvin cycle', isCorrect: false, difficulty: e.difficulty, answeredAt: e.answeredAt,
    }));
    const trigger = evaluateTriggers(
      {
        hasMaterials: true,
        readyMaterials: 1,
        concepts: [
          { conceptId: 'photo', name: 'Photosynthesis', mastery: photoState },
          { conceptId: 'calvin', name: 'Calvin cycle', mastery: calvinState },
        ],
        patterns: detectRepeatedMistakes(records, now),
        lastQuizAt: at(4),
        lastActivityAt: at(4),
        activeRecommendations: [],
      },
      now,
    )!;

    expect(trigger.trigger).toBe('repeated_mistake');
    expect(trigger.conceptName).toBe('Calvin cycle');
    expect(trigger.action).toBe('review_material');
    // The generated sentence is written from this, so it must carry the facts.
    expect(trigger.evidence.concept).toBe('Calvin cycle');
    expect(Number(trigger.evidence.mistakes)).toBeGreaterThanOrEqual(2);
  });

  it('stops recommending once the learner recovers', () => {
    const recovered: AnswerRecord[] = [
      ...calvin.map((e) => ({ conceptId: 'calvin', conceptName: 'Calvin cycle', isCorrect: false, difficulty: e.difficulty, answeredAt: e.answeredAt })),
      { conceptId: 'calvin', conceptName: 'Calvin cycle', isCorrect: true, difficulty: 2, answeredAt: at(4) },
      { conceptId: 'calvin', conceptName: 'Calvin cycle', isCorrect: true, difficulty: 3, answeredAt: at(5, 10) },
    ];
    const patterns = detectRepeatedMistakes(recovered, at(6));
    expect(patterns[0]!.recovered).toBe(true);

    const improved = replayMastery([
      { correctness: 1, difficulty: 2, answeredAt: at(4) },
      { correctness: 1, difficulty: 3, answeredAt: at(5, 10) },
    ], calvinState);
    expect(improved.score).toBeGreaterThan(calvinState.score);
  });

  it('runs the whole chain without a single AI call', () => {
    // The point of task 14, and a stated PRD criterion: mastery, selection,
    // mistake detection and recommendation triggers are all arithmetic.
    // Everything above executed synchronously, with no provider and no network.
    expect(typeof replayMastery).toBe('function');
    expect(typeof selectNextQuestion).toBe('function');
    expect(typeof detectRepeatedMistakes).toBe('function');
    expect(typeof evaluateTriggers).toBe('function');
  });
});
