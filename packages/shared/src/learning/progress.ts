import { masteryBand, type MasteryBand, type MasteryState } from './mastery.ts';
import type { MistakePattern } from './mistakes.ts';
import type { ActionType } from './recommend.ts';

/**
 * "Where am I, how am I doing, what next?" — answered from the record, not
 * from the material. Deterministic: no AI, no I/O, no clock except one passed
 * in.
 *
 * WHY THIS EXISTS
 *
 * The Tutor was a pure retrieval agent: every question went to RAG over the
 * learner's PDFs. Asked "Where was I, how am I doing, and what should I do
 * next?", it retrieved the document's own contents page and answered with
 * "the pages you have accessed cover: page 1... page 2..." — cited, fluent,
 * and fabricated. Nothing in a PDF knows what a learner read, and nothing in
 * retrieval knows what they scored. A progress question asked of a retrieval
 * index can only ever be answered by inventing the learner.
 *
 * The system already holds the real answer — `concept_mastery`, `quiz_attempts`,
 * repeated-mistake patterns, active recommendations — so the fix is to route
 * the question at the state instead of at the documents. WHAT the learner
 * should do next is decided here, by the same rules that drive recommendations
 * (PRD §9/§10/§13: this class of decision must be backend logic, not a model's
 * opinion). Only the wording is generated, and if generation fails,
 * `renderStudyBrief` is a complete answer on its own.
 *
 * See D-075.
 */

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** Which part of "where am I / how am I doing / what next" was asked. */
export type ProgressAspect = 'position' | 'standing' | 'weakness' | 'next';

export type TutorIntent =
  | { kind: 'material' }
  | { kind: 'progress'; aspects: ProgressAspect[] };

/**
 * Patterns that name the LEARNER rather than the subject.
 *
 * Nearly all of them require an explicit first-person reference, which is what
 * keeps the false-positive rate low: "how am I doing" is unambiguous in a way
 * that "how does this work" is not. Wording that could go either way is
 * deliberately left out — a progress question mistaken for a material question
 * gets the ordinary grounded answer, while a material question mistaken for a
 * progress question gets a report the learner did not ask for. The second
 * failure is the worse one, so the classifier errs toward `material`.
 */
const ASPECT_PATTERNS: Record<ProgressAspect, RegExp[]> = {
  position: [
    /\bwhere\s+(?:am|was|were|did|have)\s+i\b/i,
    /\bwhere\s+i\s+(?:am|was|left)\b/i,
    /\b(?:left|leave|leaving)\s+off\b/i,
    /\bpick(?:ing)?\s+(?:it\s+|this\s+|things\s+)?up\s+where\b/i,
    /\bhow\s+far\s+(?:have|am|did|into)\s+i\b/i,
    /\bwhat\s+(?:have|did)\s+i\s+(?:already\s+)?(?:cover|covered|read|study|studied|learn|learnt|learned|done|do)\b/i,
  ],
  standing: [
    /\bhow\s+(?:am|are|was)\s+i\s+doing\b/i,
    /\bhow\s+(?:did|have|has)\s+i\s+(?:do|done|been)\b/i,
    /\bmy\s+(?:progress|performance|mastery|scores?|results?|stats|marks?|standing|level)\b/i,
    /\bam\s+i\s+(?:improving|getting\s+better|on\s+track|ready|progressing|any\s+good)\b/i,
    /\bhow\s+much\s+(?:have\s+i|do\s+i|i've)\b/i,
    /\bsummar(?:ise|ize)\s+my\b/i,
  ],
  weakness: [
    /\bmy\s+(?:weak(?:est)?|strong(?:est)?)\b/i,
    /\bwhat\s+am\s+i\s+(?:bad|weak|good|strong|struggling)\b/i,
    /\b(?:what|which)\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?(?:work\s+on|improve|revise|practi[sc]e)\b/i,
    /\bwhat\s+(?:do\s+i|am\s+i)\b[^?.!]{0,40}\b(?:keep\s+(?:getting|missing)|getting\s+wrong)\b/i,
    /\bam\s+i\s+(?:weak|struggling|bad)\b/i,
  ],
  next: [
    /\bwhat\s+(?:should|shall|do|can|must|ought\s+to|would)\s+i\s+(?:do|study|learn|read|revise|review|focus|work|practi[sc]e|cover|tackle|start)\b/i,
    /\bwhere\s+(?:should|do|can)\s+i\s+(?:start|begin|go)\b/i,
    /\bwhat\s+(?:should|do)\s+i\s+(?:need\s+to\s+)?(?:learn|study|know)\s+next\b/i,
  ],
};

/**
 * "What next?" with no first person in it.
 *
 * Progress when it stands alone, a material question when it names a topic:
 * "what's next?" is about the learner, "what's next in the RAG pipeline?" is
 * about the pipeline. The tail test is what separates them.
 */
const BARE_NEXT = /\b(?:what(?:'s|s| is)?\s+next|next\s+steps?|what\s+now)\b/i;
const BARE_NEXT_TOPIC_TAIL =
  /\b(?:what(?:'s|s| is)?\s+next|next\s+steps?|what\s+now)\b\s*(?:in|on|about|after|within|with|for|to)\b\s+(?!me\b|my\b|i\b|us\b)/i;

/**
 * Decides whether a question is about the learner or about the material.
 *
 * Deterministic and cheap on purpose. Asking a model to classify would cost a
 * round trip against an 8000 TPM ceiling before the real request, and would
 * make routing unexplainable — the returned aspects are exactly the patterns
 * that matched.
 */
export function classifyTutorIntent(question: string): TutorIntent {
  const aspects: ProgressAspect[] = [];

  for (const aspect of ['position', 'standing', 'weakness', 'next'] as ProgressAspect[]) {
    if (ASPECT_PATTERNS[aspect].some((re) => re.test(question))) aspects.push(aspect);
  }

  if (!aspects.includes('next') && BARE_NEXT.test(question) && !BARE_NEXT_TOPIC_TAIL.test(question)) {
    aspects.push('next');
  }

  return aspects.length > 0 ? { kind: 'progress', aspects } : { kind: 'material' };
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export type ProgressMaterial = {
  filename: string;
  status: string;
  pageCount: number | null;
};

export type ProgressConcept = {
  conceptId: string;
  name: string;
  mastery: MasteryState;
};

export type ProgressQuiz = {
  score: number | null;
  questionsAnswered: number;
  completedAt: Date | null;
};

export type ProgressInput = {
  projectName: string;
  goal?: string | null;
  materials: ProgressMaterial[];
  concepts: ProgressConcept[];
  /** Repeated-mistake patterns, from the same detector the worker uses. */
  patterns: MistakePattern[];
  /** Completed attempts, most recent first. */
  quizzes: ProgressQuiz[];
  /** True when an attempt is sitting unfinished. */
  openAttempt: boolean;
  /** The system's own current advice, so the Tutor and the dashboard agree. */
  activeRecommendation: { title: string; body: string; action: ActionType } | null;
  lastActivityAt: Date | null;
};

export type ConceptStanding = {
  conceptId: string;
  name: string;
  band: MasteryBand;
  /** 0..100, rounded. Percent rather than the raw 0..1 score: the brief is read. */
  percent: number;
  evidenceCount: number;
};

export type NextStep = {
  action: ActionType;
  /** Imperative. Shown verbatim when generation is unavailable. */
  label: string;
  /** Why this step and not another, in the learner's terms. */
  why: string;
  concepts: string[];
};

/**
 * Where the learner is in the only sequence the system can actually observe:
 * material in → concepts extracted → assessed → improving.
 *
 * Note what is NOT here: how far through a document they have read. Nothing
 * records that, so the brief never claims it. Saying "you are on page 3" when
 * page 3 is merely a page that exists is the exact failure this module was
 * written to remove.
 */
export type BriefStage = 'no_materials' | 'processing' | 'not_assessed' | 'assessed';

export type StudyBrief = {
  stage: BriefStage;
  /** One line the learner could read on its own and know where they stand. */
  headline: string;
  /** "Where you are" — observed facts, already worded. */
  position: string[];
  /** "How you're doing" — measured standing. Empty until there is evidence. */
  standing: string[];
  strengths: ConceptStanding[];
  /** Weakest first. What "you have to learn these" actually points at. */
  focus: ConceptStanding[];
  untested: ConceptStanding[];
  /** Ordered, best first. Never empty — there is always a next action. */
  steps: NextStep[];
};

/** How many concepts to name in any one list. A wall of names is not advice. */
const NAMED_CONCEPTS = 3;

export function buildStudyBrief(input: ProgressInput, now: Date = new Date()): StudyBrief {
  const ready = input.materials.filter((m) => m.status === 'ready');
  const pending = input.materials.filter((m) => m.status !== 'ready' && m.status !== 'failed');
  const failed = input.materials.filter((m) => m.status === 'failed');

  const standings: ConceptStanding[] = input.concepts.map((c) => ({
    conceptId: c.conceptId,
    name: c.name,
    band: masteryBand(c.mastery, now),
    percent: Math.round(c.mastery.score * 100),
    evidenceCount: c.mastery.evidenceCount,
  }));

  const assessed = standings.filter((s) => s.evidenceCount > 0);
  const untested = standings.filter((s) => s.evidenceCount === 0);
  const strengths = assessed.filter((s) => s.band === 'secure').sort((a, b) => b.percent - a.percent);

  // Weakest first, and `needs_work` always ahead of `developing` — the band is
  // the judgement, the percent only orders within it.
  const focus = assessed
    .filter((s) => s.band === 'needs_work' || s.band === 'developing')
    .sort((a, b) => bandRank(a.band) - bandRank(b.band) || a.percent - b.percent);

  // A concept the learner keeps getting wrong outranks a merely low score:
  // repetition is evidence that re-reading has not worked yet.
  const live = input.patterns.filter((p) => !p.recovered);
  const stuck = live
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .map((p) => focus.find((f) => f.conceptId === p.conceptId) ?? standingFor(p, standings))
    .filter((s): s is ConceptStanding => s !== null);

  const orderedFocus = dedupeById([...stuck, ...focus]);

  const stage: BriefStage =
    input.materials.length === 0
      ? 'no_materials'
      : ready.length === 0
        ? 'processing'
        : assessed.length === 0
          ? 'not_assessed'
          : 'assessed';

  return {
    stage,
    headline: headlineFor(stage, { assessed, orderedFocus, strengths, quizzes: input.quizzes }),
    position: positionLines(input, { ready, pending, failed, standings, assessed, now }),
    standing: standingLines(input, { assessed, strengths, orderedFocus, untested, now }),
    strengths: strengths.slice(0, NAMED_CONCEPTS),
    focus: orderedFocus.slice(0, NAMED_CONCEPTS),
    untested: untested.slice(0, NAMED_CONCEPTS),
    steps: nextSteps(input, { stage, orderedFocus, untested, strengths, live }),
  };
}

function bandRank(band: MasteryBand): number {
  return band === 'needs_work' ? 0 : band === 'developing' ? 1 : 2;
}

function severityRank(severity: MistakePattern['severity']): number {
  return severity === 'blocked' ? 2 : severity === 'struggling' ? 1 : 0;
}

function standingFor(pattern: MistakePattern, standings: ConceptStanding[]): ConceptStanding | null {
  return standings.find((s) => s.conceptId === pattern.conceptId) ?? null;
}

function dedupeById(items: ConceptStanding[]): ConceptStanding[] {
  const seen = new Set<string>();
  return items.filter((s) => (seen.has(s.conceptId) ? false : (seen.add(s.conceptId), true)));
}

function headlineFor(
  stage: BriefStage,
  ctx: {
    assessed: ConceptStanding[];
    orderedFocus: ConceptStanding[];
    strengths: ConceptStanding[];
    quizzes: ProgressQuiz[];
  },
): string {
  switch (stage) {
    case 'no_materials':
      return 'This Project is empty — nothing has been uploaded yet.';
    case 'processing':
      return 'Your material is still being processed, so nothing can be assessed yet.';
    case 'not_assessed':
      return 'Your material is ready, but nothing has been measured yet — you have not taken a quiz in this Project.';
    default: {
      const weakest = ctx.orderedFocus[0];
      if (weakest) {
        return `${ctx.assessed.length} concept${plural(ctx.assessed.length)} assessed; ${weakest.name} is the weakest at ${weakest.percent}%.`;
      }
      return `${ctx.assessed.length} concept${plural(ctx.assessed.length)} assessed, and none of them are currently weak.`;
    }
  }
}

function positionLines(
  input: ProgressInput,
  ctx: {
    ready: ProgressMaterial[];
    pending: ProgressMaterial[];
    failed: ProgressMaterial[];
    standings: ConceptStanding[];
    assessed: ConceptStanding[];
    now: Date;
  },
): string[] {
  const lines: string[] = [];

  if (input.materials.length === 0) {
    lines.push('No material uploaded to this Project.');
  } else {
    const names = ctx.ready.map((m) => (m.pageCount ? `${m.filename} (${m.pageCount} pages)` : m.filename));
    if (names.length > 0) {
      lines.push(`Material indexed: ${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names.length - 3} more` : ''}.`);
    }
    if (ctx.pending.length > 0) {
      lines.push(`${ctx.pending.length} document${plural(ctx.pending.length)} still processing.`);
    }
    if (ctx.failed.length > 0) {
      lines.push(`${ctx.failed.length} document${plural(ctx.failed.length)} failed to process and needs a retry.`);
    }
  }

  if (ctx.standings.length > 0) {
    lines.push(`${ctx.standings.length} concept${plural(ctx.standings.length)} identified in that material.`);
  }

  // The honest form of "where was I". The system records what was answered,
  // never what was read, so it says exactly that and nothing more.
  const done = input.quizzes.length;
  if (done > 0) {
    const answered = input.quizzes.reduce((sum, q) => sum + q.questionsAnswered, 0);
    const last = input.quizzes[0]!;
    const when = last.completedAt ? ` (${relativeDay(last.completedAt, ctx.now)})` : '';
    const score = last.score === null ? '' : `, most recently ${Math.round(last.score * 100)}%`;
    lines.push(`${done} quiz${done === 1 ? '' : 'zes'} completed, ${answered} question${plural(answered)} answered${score}${when}.`);
  } else {
    lines.push('No quiz completed yet, so nothing has been measured about what you know.');
  }

  if (input.openAttempt) lines.push('You have a quiz in progress that was never finished.');

  if (input.lastActivityAt) {
    const days = daysBetween(input.lastActivityAt, ctx.now);
    if (days >= 1) lines.push(`Last active on this Project ${relativeDay(input.lastActivityAt, ctx.now)}.`);
  }

  return lines;
}

function standingLines(
  input: ProgressInput,
  ctx: {
    assessed: ConceptStanding[];
    strengths: ConceptStanding[];
    orderedFocus: ConceptStanding[];
    untested: ConceptStanding[];
    now: Date;
  },
): string[] {
  if (ctx.assessed.length === 0) {
    return [
      'Nothing measured yet. Mastery only moves when you answer quiz questions, so there is no score to report.',
    ];
  }

  const lines: string[] = [];
  const total = ctx.assessed.length + ctx.untested.length;
  lines.push(`${ctx.assessed.length} of ${total} concept${plural(total)} have been tested.`);

  if (ctx.strengths.length > 0) {
    lines.push(`Secure: ${nameList(ctx.strengths)}.`);
  }
  if (ctx.orderedFocus.length > 0) {
    lines.push(`Needs work: ${nameList(ctx.orderedFocus)}.`);
  }
  if (ctx.untested.length > 0) {
    lines.push(`Not yet tested: ${nameList(ctx.untested)}.`);
  }

  for (const p of input.patterns.filter((x) => !x.recovered).slice(0, 2)) {
    lines.push(
      `Repeated mistakes on ${p.conceptName}: ${p.mistakes} of ${p.attempts} recent answers wrong, at difficulty ${Math.round(p.meanDifficulty)} of 5.`,
    );
  }

  // Direction, from the two most recent completed quizzes. Two points is not a
  // trend line, so the wording stays comparative rather than predictive.
  const [latest, previous] = input.quizzes;
  if (latest?.score != null && previous?.score != null) {
    const delta = Math.round((latest.score - previous.score) * 100);
    if (Math.abs(delta) >= 5) {
      lines.push(
        `Your last quiz scored ${Math.round(latest.score * 100)}%, ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points on the one before it.`,
      );
    } else {
      lines.push(`Your last two quizzes scored ${Math.round(latest.score * 100)}% and ${Math.round(previous.score * 100)}% — roughly level.`);
    }
  }

  return lines;
}

/**
 * What to do next.
 *
 * Same decision the recommendation engine makes, reached the same way: from
 * state, in priority order. When a recommendation is already active it leads,
 * so the Tutor and the dashboard card never tell the learner two different
 * things — the card exists precisely because the system already decided.
 */
function nextSteps(
  input: ProgressInput,
  ctx: {
    stage: BriefStage;
    orderedFocus: ConceptStanding[];
    untested: ConceptStanding[];
    strengths: ConceptStanding[];
    live: MistakePattern[];
  },
): NextStep[] {
  const steps: NextStep[] = [];

  if (input.activeRecommendation) {
    steps.push({
      action: input.activeRecommendation.action,
      label: input.activeRecommendation.title,
      why: input.activeRecommendation.body,
      concepts: [],
    });
  }

  switch (ctx.stage) {
    case 'no_materials':
      steps.push({
        action: 'upload_material',
        label: 'Upload a PDF to this Project.',
        why: 'Everything else — concepts, quizzes, mastery — is derived from your own material, so there is nothing to work from until one is in.',
        concepts: [],
      });
      break;

    case 'processing':
      steps.push({
        action: 'review_material',
        label: 'Give the upload a minute to finish processing, then reload.',
        why: 'Concepts are extracted and the text is indexed after upload. Quizzes and grounded answers both wait on that.',
        concepts: [],
      });
      break;

    case 'not_assessed': {
      const names = ctx.untested.slice(0, NAMED_CONCEPTS).map((c) => c.name);
      steps.push({
        action: 'take_quiz',
        label: 'Take a short quiz — five questions is enough to start.',
        why: `Nothing is measured until you answer something. The first quiz establishes where you actually stand${names.length ? `, starting with ${names.join(', ')}` : ''}.`,
        concepts: names,
      });
      if (names.length > 0) {
        steps.push({
          action: 'ask_tutor',
          label: `Ask me to explain ${names[0]} before you start, if it is unfamiliar.`,
          why: 'A quiz measures what you know; it does not teach. Read first if the concept is new to you.',
          concepts: [names[0]!],
        });
      }
      break;
    }

    default: {
      const weakest = ctx.orderedFocus[0];
      const stuckOn = ctx.live[0];

      if (stuckOn) {
        steps.push({
          action: 'ask_tutor',
          label: `Have me re-explain ${stuckOn.conceptName}, then re-read that part of your material.`,
          why: `You have got ${stuckOn.conceptName} wrong ${stuckOn.mistakes} times recently. Another quiz on it before the idea changes shape would just repeat the mistake.`,
          concepts: [stuckOn.conceptName],
        });
      } else if (weakest) {
        steps.push({
          action: 'review_material',
          label: `Review ${weakest.name} — it is your weakest concept at ${weakest.percent}%.`,
          why: 'Practice is worth most where mastery is lowest, and this is the lowest the record shows.',
          concepts: [weakest.name],
        });
      }

      if (ctx.untested.length > 0) {
        const names = ctx.untested.slice(0, NAMED_CONCEPTS).map((c) => c.name);
        steps.push({
          action: 'take_quiz',
          label: `Take a quiz covering ${names.join(', ')}.`,
          why: 'These concepts have no evidence either way yet, so the system cannot tell whether they are a gap or already solid.',
          concepts: names,
        });
      } else {
        steps.push({
          action: 'take_quiz',
          label: weakest ? `Take another quiz to re-test ${weakest.name}.` : 'Take another quiz to keep the estimates fresh.',
          why: weakest
            ? 'Re-testing after review is what moves a mastery score; reading alone does not.'
            : 'Every concept is currently secure. A harder quiz is the way to find the edge of what you know.',
          concepts: weakest ? [weakest.name] : [],
        });
      }
      break;
    }
  }

  return steps.slice(0, 3);
}

/**
 * The brief as an answer in its own right.
 *
 * Two jobs: it is what the model is asked to reword, and it is what the learner
 * sees if that call fails or its output cannot be trusted. A progress answer
 * must never be unavailable — every fact in it is already computed, and
 * failing to render text over a model outage would be an odd way to lose a
 * feature that needs no model.
 */
export function renderStudyBrief(brief: StudyBrief): string {
  const out: string[] = [`**Where you are**`, ...brief.position.map(bullet), ``, `**How you're doing**`, ...brief.standing.map(bullet), ``, `**What to do next**`];

  brief.steps.forEach((step, i) => {
    out.push(`${i + 1}. **${step.label}** ${step.why}`);
  });

  return out.join('\n');
}

function bullet(line: string): string {
  return `- ${line}`;
}

function nameList(items: ConceptStanding[]): string {
  return items
    .slice(0, NAMED_CONCEPTS)
    .map((s) => (s.evidenceCount > 0 ? `${s.name} (${s.percent}%)` : s.name))
    .join(', ');
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function relativeDay(at: Date, now: Date): string {
  const days = daysBetween(at, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
