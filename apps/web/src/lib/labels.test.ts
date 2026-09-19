import { describe, expect, it } from 'vitest';
import {
  EVENT_COUNT,
  EVENT_ICONS,
  EVENT_TIMELINE,
  FEATURE_LABELS,
  eventCountLabel,
  eventIcon,
  eventLabel,
  featureLabel,
  humanise,
} from './labels.ts';

/**
 * The lists below are the database CHECK constraints in
 * `0010_flashcards.sql`, copied deliberately. If an event type or AI feature is
 * added to the schema without being added here, this file is the reminder — and
 * the bug it is here to stop was exactly that: `flashcards_generated` and
 * `flashcard_reviewed` reaching a learner's activity feed as raw column values.
 */
const EVENT_TYPES = [
  'space_created',
  'project_created',
  'material_uploaded',
  'material_processing',
  'material_ready',
  'material_failed',
  'tutor_question',
  'tutor_answer',
  'tutor_unsupported',
  'quiz_started',
  'question_answered',
  'quiz_completed',
  'mastery_updated',
  'weakness_detected',
  'recommendation_created',
  'flashcards_generated',
  'flashcard_reviewed',
];

const AI_FEATURES = [
  'tutor_answer',
  'concept_extraction',
  'question_generation',
  'open_answer_grading',
  'recommendation',
  'embedding',
  'evaluation',
  'flashcard_generation',
];

/**
 * Asserted against the maps themselves, not against what the accessors return:
 * `humanise` would turn a missing `flashcards_generated` into "Flashcards
 * generated", so a test that only checked the output for underscores would have
 * passed while the bug was live. Key-set equality is the only check that fails
 * for the thing that actually went wrong — and it fails in both directions, so
 * a type removed from the schema does not leave a dead label behind.
 */
describe('event labels', () => {
  it('maps every event type the database accepts, and nothing it does not', () => {
    expect(Object.keys(EVENT_TIMELINE).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(EVENT_COUNT).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(EVENT_ICONS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('maps every AI feature the database accepts, and nothing it does not', () => {
    expect(Object.keys(FEATURE_LABELS).sort()).toEqual([...AI_FEATURES].sort());
  });

  it('never renders a label that still looks like a column value', () => {
    const looksMachine = (s: string) => /_/.test(s) || s === s.toLowerCase();
    for (const type of EVENT_TYPES) {
      expect(looksMachine(eventLabel(type)), `timeline label for ${type}`).toBe(false);
      expect(looksMachine(eventCountLabel(type)), `count label for ${type}`).toBe(false);
      expect(eventIcon(type), `icon for ${type}`).not.toBe('info');
    }
    for (const feature of AI_FEATURES) {
      expect(looksMachine(featureLabel(feature)), `feature label for ${feature}`).toBe(false);
    }
  });

  it('counts read as totals and timeline entries read as things that happened', () => {
    expect(eventLabel('flashcards_generated')).toBe('Flashcards added');
    expect(eventLabel('quiz_completed')).toBe('Completed a quiz');
    expect(eventCountLabel('quiz_completed')).toBe('Quizzes completed');
    expect(eventCountLabel('flashcard_reviewed')).toBe('Flashcard reviews');
  });
});

describe('humanise', () => {
  it('turns an unmapped type into prose rather than leaking the raw value', () => {
    // The point of the fallback: a type added to the schema and missed here
    // still reads as English on the page.
    expect(humanise('flashcards_generated')).toBe('Flashcards generated');
    expect(humanise('some_future_event')).toBe('Some future event');
  });

  it('falls back for unknown types on every accessor', () => {
    expect(eventLabel('brand_new_thing')).toBe('Brand new thing');
    expect(eventCountLabel('brand_new_thing')).toBe('Brand new thing');
    expect(featureLabel('brand_new_thing')).toBe('Brand new thing');
    // The icon has no sensible guess, so it stays generic on purpose.
    expect(eventIcon('brand_new_thing')).toBe('info');
  });

  it('does not crash on an empty or already-human value', () => {
    expect(humanise('')).toBe('');
    expect(humanise('Already Human')).toBe('Already Human');
  });
});
