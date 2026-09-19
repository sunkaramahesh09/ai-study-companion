/**
 * "in 3 days", "in 4 hours", "now".
 *
 * A flashcard's due date is only ever read as a distance: "when does this come
 * back?" A calendar date makes the learner do that subtraction themselves, and
 * for the ten-minute relearning step (D-080) a date says nothing at all.
 *
 * `now` is a parameter so the wording is testable without freezing the clock.
 */
export function relativeDue(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return 'unknown';
  if (ms <= 0) return 'now';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');

  return plural(Math.round(hours / 24), 'day');
}

const plural = (n: number, unit: string) => `in ${n} ${unit}${n === 1 ? '' : 's'}`;
