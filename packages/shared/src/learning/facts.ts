/**
 * Selecting durable learner context for a Tutor request.
 *
 * Deterministic — no AI, no I/O. The PRD (§11) asks for persistent learning
 * context retrieved *selectively*, not for the learner's whole profile to be
 * pasted into every prompt. Two reasons that distinction matters here:
 *
 *  1. TPM is the binding constraint on the generation provider, so every fact
 *     sent is evidence not sent.
 *  2. A Tutor that opens an answer about convolution by mentioning the
 *     learner's unrelated weakness in regularisation reads as a non-sequitur.
 *     Relevance is what makes remembered context feel like memory rather than
 *     like a profile being recited.
 */

export type LearnerFactKind = 'goal' | 'strength' | 'weakness' | 'preference' | 'mistake_pattern';

export type LearnerFact = {
  kind: LearnerFactKind;
  content: string;
  /** Name of the concept the fact is about, when it is about one. */
  conceptName?: string | null;
  /** 0..1, as stored. Decayed on read rather than written down as decayed. */
  salience: number;
  lastSeenAt?: Date | null;
};

export type FactSelection = {
  facts: LearnerFact[];
  /** Per-fact scores, so a test or an admin view can explain the choice. */
  scores: { fact: LearnerFact; score: number; relevant: boolean }[];
};

/**
 * How quickly an unrepeated observation stops being worth prompt space.
 *
 * Shorter than the mastery staleness half-life (21 days): a concept a learner
 * once struggled with is durable knowledge, but "they are currently weak on
 * this" is a claim about the present, and stating it months later is likely to
 * be wrong in the direction that damages trust.
 */
const SALIENCE_HALF_LIFE_DAYS = 10;

/**
 * Below this, a fact is not worth the tokens.
 *
 * Set so that a default-salience (0.5) fact drops out after roughly three
 * half-lives without being re-observed.
 */
const SALIENCE_FLOOR = 0.08;

/**
 * Facts that shape *how* to explain regardless of topic.
 *
 * A goal or a stated preference ("I want worked examples") applies to every
 * answer. A weakness applies to answers about that weakness. Kinds in this set
 * therefore skip the relevance gate; the others must earn their place.
 */
const TOPIC_INDEPENDENT: ReadonlySet<LearnerFactKind> = new Set(['goal', 'preference']);

/** Default cap. Four short facts is roughly 100 tokens of system prompt. */
const DEFAULT_LIMIT = 3;

export type SelectFactsOptions = {
  /** The learner's question, used for lexical relevance. */
  question: string;
  /**
   * The passage the answer is primarily grounded in — the TOP-RANKED chunk,
   * not the whole retrieval set.
   *
   * This exists for follow-ups: "explain that more simply" names no concept,
   * but the passage it follows up on does. Passing the full retrieval set
   * instead makes the gate useless on a small project, where retrieval returns
   * most of the document and every stored fact therefore looks relevant. That
   * is not hypothetical — it is what the first version did. See D-050.
   */
  evidence?: string;
  now?: Date;
  limit?: number;
};

export function selectFacts(candidates: LearnerFact[], opts: SelectFactsOptions): FactSelection {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const haystack = tokenSet(`${opts.question} ${opts.evidence ?? ''}`);

  const scores = candidates.map((fact) => {
    const decayed = decaySalience(fact, now);
    const relevant = isRelevant(fact, haystack);

    // Topic-independent kinds are always applicable; a weakness that has
    // nothing to do with the question is noise, so it scores zero and is
    // filtered out below rather than merely ranked low.
    const applicable = TOPIC_INDEPENDENT.has(fact.kind) || relevant;
    const score = applicable ? decayed * (relevant ? 1 : 0.7) : 0;
    return { fact, score: round4(score), relevant };
  });

  const chosen = scores
    .filter((s) => s.score >= SALIENCE_FLOOR)
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Stable tie-break so the same inputs always produce the same prompt.
        a.fact.kind.localeCompare(b.fact.kind) ||
        a.fact.content.localeCompare(b.fact.content),
    )
    .slice(0, limit);

  return { facts: chosen.map((s) => s.fact), scores };
}

/** Salience as of `now`, without mutating what is stored. */
export function decaySalience(fact: LearnerFact, now: Date = new Date()): number {
  if (!fact.lastSeenAt) return round4(fact.salience);
  const days = Math.max(0, (now.getTime() - fact.lastSeenAt.getTime()) / 86_400_000);
  return round4(fact.salience * 0.5 ** (days / SALIENCE_HALF_LIFE_DAYS));
}

/**
 * Lexical relevance: does this fact's subject come up in the question or the
 * retrieved evidence?
 *
 * Deliberately lexical rather than embedded. The facts being matched are short
 * and name concepts that were themselves extracted from this project's
 * material, so the vocabulary already agrees; an embedding call here would add
 * latency and quota to a decision a set intersection answers.
 */
function isRelevant(fact: LearnerFact, haystack: Set<string>): boolean {
  const subject = fact.conceptName ?? fact.content;
  const terms = [...tokenSet(subject)];
  if (terms.length === 0) return false;
  // A concept name is usually one or two words; requiring every significant
  // term avoids matching "gradient descent" on the word "gradient" alone.
  return terms.every((t) => haystack.has(t));
}

/** Lowercased significant terms. Stopwords would match everything. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(singular(raw));
  }
  return out;
}

/** Crude but sufficient: "networks" must match "network". */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'did', 'yes', 'this', 'that', 'with', 'from', 'they', 'what', 'when', 'your',
  'have', 'more', 'will', 'would', 'about', 'there', 'their', 'which', 'them', 'then', 'than',
  'does', 'into', 'some', 'very', 'just', 'like', 'want', 'need', 'explain', 'tell',
]);

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
