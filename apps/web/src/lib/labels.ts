import type { IconName } from '../components/Icon.tsx';

/**
 * Human wording for the machine names in `learning_events.event_type` and
 * `ai_requests.feature`.
 *
 * These maps used to live inline in the two components that needed them, which
 * is how `flashcards_generated` and `flashcard_reviewed` ended up on a
 * learner's Recent Activity feed as raw snake_case: adding an event type means
 * touching a table constraint, a TypeScript union and the emitter, and the two
 * display maps were simply missed. One module now owns every label, and
 * `humanise` catches anything that is still missed — an unmapped type reads as
 * prose rather than as a database value.
 *
 * The Admin Dashboard deliberately does *not* use these. It shows the raw type
 * in a mono column because an operator filtering activity by type needs the
 * value the API actually takes (PRD §16).
 */

/** `flashcards_generated` → `Flashcards generated`. Last line of defence. */
export function humanise(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').trim();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Timeline phrasing — one event that happened, read as a line in a feed. */
export const EVENT_TIMELINE: Record<string, string> = {
  space_created: 'Space created',
  project_created: 'Project created',
  material_uploaded: 'Material uploaded',
  material_processing: 'Processing material',
  material_ready: 'Material processed',
  material_failed: 'Processing failed',
  tutor_question: 'Asked the Tutor',
  tutor_answer: 'Tutor answered',
  tutor_unsupported: 'Tutor had insufficient evidence',
  quiz_started: 'Started a quiz',
  question_answered: 'Answered a question',
  quiz_completed: 'Completed a quiz',
  mastery_updated: 'Mastery updated',
  weakness_detected: 'Weak concept spotted',
  recommendation_created: 'New recommendation',
  flashcards_generated: 'Flashcards added',
  flashcard_reviewed: 'Reviewed a flashcard',
};

/** Counting phrasing — the same types as a total on a chart axis. */
export const EVENT_COUNT: Record<string, string> = {
  space_created: 'Spaces created',
  project_created: 'Projects created',
  material_uploaded: 'Materials uploaded',
  material_processing: 'Materials processing',
  material_ready: 'Materials processed',
  material_failed: 'Processing failures',
  tutor_question: 'Tutor questions',
  tutor_answer: 'Tutor answers',
  tutor_unsupported: 'Tutor declined',
  quiz_started: 'Quizzes started',
  question_answered: 'Questions answered',
  quiz_completed: 'Quizzes completed',
  mastery_updated: 'Mastery updates',
  weakness_detected: 'Weaknesses detected',
  recommendation_created: 'Recommendations',
  flashcards_generated: 'Flashcards added',
  flashcard_reviewed: 'Flashcard reviews',
};

export const EVENT_ICONS: Record<string, IconName> = {
  space_created: 'folder',
  project_created: 'sparkle',
  material_uploaded: 'file',
  material_processing: 'clock',
  material_ready: 'check-circle',
  material_failed: 'x-circle',
  tutor_question: 'tutor',
  tutor_answer: 'tutor',
  tutor_unsupported: 'alert',
  quiz_started: 'play',
  question_answered: 'check',
  quiz_completed: 'trophy',
  mastery_updated: 'chart-bar',
  weakness_detected: 'target',
  recommendation_created: 'bulb',
  flashcards_generated: 'cards',
  flashcard_reviewed: 'cards',
};

/** Which product surface spent the tokens. Mirrors `ai_requests.feature`. */
export const FEATURE_LABELS: Record<string, string> = {
  tutor_answer: 'Tutor answers',
  concept_extraction: 'Concept extraction',
  question_generation: 'Question generation',
  flashcard_generation: 'Flashcard generation',
  open_answer_grading: 'Answer grading',
  recommendation: 'Recommendations',
  embedding: 'Embeddings',
  evaluation: 'Evaluation',
};

export function eventLabel(type: string): string {
  return EVENT_TIMELINE[type] ?? humanise(type);
}

export function eventCountLabel(type: string): string {
  return EVENT_COUNT[type] ?? humanise(type);
}

export function eventIcon(type: string): IconName {
  return EVENT_ICONS[type] ?? 'info';
}

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? humanise(feature);
}
