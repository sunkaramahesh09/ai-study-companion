/**
 * Repeated-mistake detection. Deterministic — no AI, no I/O.
 *
 * The PRD asks for a repeated-mistake workflow that identifies a pattern,
 * updates learning context and generates a targeted recommendation (§13). The
 * pattern IDENTIFICATION is here; only the sentence describing it is generated.
 */

export type AnswerRecord = {
  conceptId: string | null;
  conceptName: string;
  isCorrect: boolean;
  difficulty: number;
  answeredAt: Date;
};

export type MistakePattern = {
  conceptId: string;
  conceptName: string;
  /** Wrong answers inside the window. */
  mistakes: number;
  attempts: number;
  /** 0..1 — how much of the recent evidence on this concept is wrong. */
  errorRate: number;
  /** True when the learner has since answered this concept correctly. */
  recovered: boolean;
  /** Mistakes are more telling at low difficulty than at high. */
  meanDifficulty: number;
  severity: 'watch' | 'struggling' | 'blocked';
  lastMistakeAt: Date;
};

export type DetectOptions = {
  /** Only look at answers this recent. */
  windowDays?: number;
  /** Fewest wrong answers before it counts as a pattern rather than a slip. */
  minMistakes?: number;
  /** Fewest attempts before an error rate means anything. */
  minAttempts?: number;
};

/**
 * Finds concepts the learner keeps getting wrong.
 *
 * Two mistakes, not one: a single wrong answer is a slip, and treating it as a
 * pattern would flood the learner with recommendations after any normal quiz.
 * The PRD's own wording is "repeated".
 */
export function detectRepeatedMistakes(
  answers: AnswerRecord[],
  now: Date = new Date(),
  options: DetectOptions = {},
): MistakePattern[] {
  const windowDays = options.windowDays ?? 14;
  const minMistakes = options.minMistakes ?? 2;
  const minAttempts = options.minAttempts ?? 2;

  const cutoff = now.getTime() - windowDays * 86_400_000;
  const byConcept = new Map<string, AnswerRecord[]>();

  for (const a of answers) {
    // Answers not tied to a concept cannot form a concept-level pattern.
    if (!a.conceptId) continue;
    if (a.answeredAt.getTime() < cutoff) continue;
    const list = byConcept.get(a.conceptId) ?? [];
    list.push(a);
    byConcept.set(a.conceptId, list);
  }

  const patterns: MistakePattern[] = [];

  for (const [conceptId, records] of byConcept) {
    const ordered = [...records].sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
    const wrong = ordered.filter((r) => !r.isCorrect);

    if (wrong.length < minMistakes || ordered.length < minAttempts) continue;

    const lastMistake = wrong[wrong.length - 1]!;
    // Recovered when the learner has answered correctly SINCE the last mistake.
    // Without this the system would keep nagging about something already fixed.
    const recovered = ordered.some(
      (r) => r.isCorrect && r.answeredAt.getTime() > lastMistake.answeredAt.getTime(),
    );

    const errorRate = wrong.length / ordered.length;
    const meanDifficulty = wrong.reduce((s, r) => s + r.difficulty, 0) / wrong.length;

    patterns.push({
      conceptId,
      conceptName: lastMistake.conceptName,
      mistakes: wrong.length,
      attempts: ordered.length,
      errorRate: round4(errorRate),
      recovered,
      meanDifficulty: round4(meanDifficulty),
      severity: severityOf(wrong.length, errorRate, meanDifficulty, recovered),
      lastMistakeAt: lastMistake.answeredAt,
    });
  }

  // Worst first, deterministic tie-break so the same evidence always ranks the
  // same way.
  return patterns.sort(
    (a, b) =>
      rank(b.severity) - rank(a.severity) ||
      b.errorRate - a.errorRate ||
      a.conceptId.localeCompare(b.conceptId),
  );
}

/**
 * Severity weighs difficulty, not just count.
 *
 * Repeatedly missing easy questions on a concept is a stronger signal of a gap
 * than missing hard ones — hard questions are supposed to be missed sometimes.
 */
function severityOf(
  mistakes: number,
  errorRate: number,
  meanDifficulty: number,
  recovered: boolean,
): MistakePattern['severity'] {
  if (recovered) return 'watch';
  const easyMistakes = meanDifficulty <= 2.5;
  if (errorRate >= 0.75 && mistakes >= 3) return 'blocked';
  if (easyMistakes && mistakes >= 2 && errorRate >= 0.5) return 'blocked';
  if (errorRate >= 0.5) return 'struggling';
  return 'watch';
}

function rank(s: MistakePattern['severity']): number {
  return s === 'blocked' ? 3 : s === 'struggling' ? 2 : 1;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
