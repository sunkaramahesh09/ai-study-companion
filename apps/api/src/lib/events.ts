import { serviceClient } from './supabase.ts';

export type LearningEventType =
  | 'space_created'
  | 'project_created'
  | 'material_uploaded'
  | 'material_processing'
  | 'material_ready'
  | 'material_failed'
  | 'tutor_question'
  | 'tutor_answer'
  | 'tutor_unsupported'
  | 'quiz_started'
  | 'question_answered'
  | 'quiz_completed'
  | 'mastery_updated'
  | 'weakness_detected'
  | 'recommendation_created';

export type LearningEvent = {
  userId: string;
  type: LearningEventType;
  projectId?: string | null;
  spaceId?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Makes emission safe to retry. A background job that runs twice records the
   * event once — the PRD asks for exactly this ("retries, duplicate events,
   * and idempotency", §12). Omit for genuinely repeatable user actions like
   * asking the Tutor the same question twice.
   */
  idempotencyKey?: string;
};

/**
 * Appends to the activity spine that feeds user-facing activity, analytics,
 * recommendations and admin visibility (PRD §12).
 *
 * Uses the service role because `learning_events` has a SELECT policy and no
 * INSERT policy for `authenticated` — clients read their own activity but
 * cannot forge it. `userId` is always passed explicitly by the caller, taken
 * from the verified request context, never from the request body.
 *
 * Never throws. A failed analytics write must not fail the user's action.
 */
export async function recordEvent(event: LearningEvent): Promise<void> {
  try {
    const { error } = await serviceClient()
      .from('learning_events')
      .insert({
        user_id: event.userId,
        project_id: event.projectId ?? null,
        space_id: event.spaceId ?? null,
        event_type: event.type,
        payload: event.payload ?? {},
        idempotency_key: event.idempotencyKey ?? null,
      });

    // 23505 = unique violation on idempotency_key. That means the event is
    // already recorded, which is success, not failure.
    if (error && error.code !== '23505') {
      console.error('[events] failed to record', event.type, error.message);
    }
  } catch (error) {
    console.error('[events] unexpected failure', (error as Error).message);
  }
}
