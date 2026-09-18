import { describe, expect, it } from 'vitest';
import {
  buildStudyBrief,
  classifyTutorIntent,
  renderStudyBrief,
  type ProgressInput,
} from './progress.ts';
import type { MistakePattern } from './mistakes.ts';
import type { MasteryState } from './mastery.ts';

const NOW = new Date('2026-09-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const mastery = (score: number, evidenceCount: number, days = 1): MasteryState => ({
  score,
  evidenceCount,
  lastEvidenceAt: daysAgo(days),
});

const input = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  projectName: 'LLM',
  goal: null,
  materials: [{ filename: 'LLM_Basics.pdf', status: 'ready', pageCount: 5 }],
  concepts: [],
  patterns: [],
  quizzes: [],
  openAttempt: false,
  activeRecommendation: null,
  lastActivityAt: daysAgo(0),
  ...over,
});

const pattern = (over: Partial<MistakePattern> = {}): MistakePattern => ({
  conceptId: 'c-rag',
  conceptName: 'RAG pipeline',
  mistakes: 3,
  attempts: 4,
  errorRate: 0.75,
  recovered: false,
  meanDifficulty: 2,
  severity: 'struggling',
  lastMistakeAt: daysAgo(1),
  ...over,
});

describe('classifyTutorIntent', () => {
  // The question that started this: it was answered from the document's
  // contents page, which knows nothing about the learner.
  it('routes the three-part progress question to the progress path', () => {
    const intent = classifyTutorIntent('Where was I, how am I doing, and what should I do next?');
    expect(intent.kind).toBe('progress');
    if (intent.kind !== 'progress') return;
    expect(intent.aspects).toEqual(expect.arrayContaining(['position', 'standing', 'next']));
  });

  it.each([
    ['How am I doing?', 'standing'],
    ['show me my progress', 'standing'],
    ['am I improving?', 'standing'],
    ['where did I leave off?', 'position'],
    ['what have I covered so far', 'position'],
    ['what should I study next?', 'next'],
    ['where do I start?', 'next'],
    ['what next?', 'next'],
    ['what are my weakest concepts', 'weakness'],
    ['what do I need to work on', 'weakness'],
  ])('classifies %j as progress (%s)', (question, aspect) => {
    const intent = classifyTutorIntent(question);
    expect(intent.kind).toBe('progress');
    if (intent.kind !== 'progress') return;
    expect(intent.aspects).toContain(aspect);
  });

  // The failure that matters most. A progress question wrongly sent to
  // retrieval gets the old, unhelpful answer; a material question wrongly sent
  // to the progress path gets a report nobody asked for instead of the
  // explanation they did. So the classifier errs toward `material`.
  it.each([
    'What is an embedding?',
    'Explain the RAG pipeline simply',
    'How does fine-tuning work?',
    // "what's next" naming a topic is about the topic, not about the learner.
    "What's next in the RAG pipeline after retrieval?",
    'what comes next on page 4',
    'Give me an example of tokenisation',
    'Why do I need embeddings for search?',
    'How do I calculate cosine similarity?',
  ])('leaves %j on the material path', (question) => {
    expect(classifyTutorIntent(question).kind).toBe('material');
  });
});

describe('buildStudyBrief', () => {
  it('names uploading as the next step when the Project is empty', () => {
    const brief = buildStudyBrief(input({ materials: [] }), NOW);
    expect(brief.stage).toBe('no_materials');
    expect(brief.steps[0]!.action).toBe('upload_material');
  });

  it('waits rather than advising a quiz while material is still processing', () => {
    const brief = buildStudyBrief(
      input({ materials: [{ filename: 'a.pdf', status: 'processing', pageCount: null }] }),
      NOW,
    );
    expect(brief.stage).toBe('processing');
    expect(brief.steps.map((s) => s.action)).not.toContain('take_quiz');
  });

  describe('material uploaded, nothing answered yet — the state in the bug report', () => {
    const brief = buildStudyBrief(
      input({
        concepts: [
          { conceptId: 'c1', name: 'Tokens', mastery: mastery(0.5, 0) },
          { conceptId: 'c2', name: 'Embeddings', mastery: mastery(0.5, 0) },
          { conceptId: 'c3', name: 'RAG pipeline', mastery: mastery(0.5, 0) },
        ],
      }),
      NOW,
    );

    it('says plainly that nothing has been measured', () => {
      expect(brief.stage).toBe('not_assessed');
      expect(brief.standing.join(' ')).toMatch(/nothing measured/i);
      expect(brief.position.join(' ')).toMatch(/no quiz completed yet/i);
    });

    it('answers "what next" with a quiz that names the concepts it will cover', () => {
      expect(brief.steps[0]!.action).toBe('take_quiz');
      expect(brief.steps[0]!.concepts).toEqual(['Tokens', 'Embeddings', 'RAG pipeline']);
    });

    /**
     * The whole point of the module. Nothing in the system records which pages
     * a learner has read, so no line of the brief may imply that it does —
     * that claim is what the retrieval path invented.
     */
    it('never claims to know what the learner has read', () => {
      const claim = /\byou (?:have |'ve )?(?:opened|read|accessed|viewed|visited|seen)\b/i;
      expect(brief.position.join(' ')).not.toMatch(claim);
      expect(brief.standing.join(' ')).not.toMatch(claim);
      expect(brief.headline).not.toMatch(claim);
    });
  });

  describe('assessed learner', () => {
    const concepts = [
      { conceptId: 'c1', name: 'Tokens', mastery: mastery(0.9, 6) },
      { conceptId: 'c2', name: 'Embeddings', mastery: mastery(0.3, 5) },
      { conceptId: 'c3', name: 'Fine-tuning', mastery: mastery(0.6, 4) },
      { conceptId: 'c4', name: 'Prompting', mastery: mastery(0.5, 0) },
    ];

    const brief = buildStudyBrief(
      input({
        concepts,
        quizzes: [
          { score: 0.8, questionsAnswered: 5, completedAt: daysAgo(1) },
          { score: 0.6, questionsAnswered: 5, completedAt: daysAgo(4) },
        ],
      }),
      NOW,
    );

    it('separates secure from weak, weakest first', () => {
      expect(brief.strengths.map((s) => s.name)).toEqual(['Tokens']);
      expect(brief.focus.map((s) => s.name)).toEqual(['Embeddings', 'Fine-tuning']);
    });

    it('keeps untested concepts out of the standing but in the plan', () => {
      expect(brief.untested.map((s) => s.name)).toEqual(['Prompting']);
      expect(brief.steps.some((s) => s.concepts.includes('Prompting'))).toBe(true);
    });

    it('reports the direction of the last two quizzes', () => {
      expect(brief.standing.join(' ')).toMatch(/up 20 points/);
    });
  });

  /**
   * A concept the learner keeps getting wrong is a different problem from a
   * concept with a merely low score: re-reading has already failed once. The
   * worker's recommendation rules make the same distinction, and the Tutor
   * must not contradict them.
   */
  it('puts a repeated mistake ahead of a lower score, and does not advise another quiz on it first', () => {
    const brief = buildStudyBrief(
      input({
        concepts: [
          { conceptId: 'c-emb', name: 'Embeddings', mastery: mastery(0.2, 5) },
          { conceptId: 'c-rag', name: 'RAG pipeline', mastery: mastery(0.4, 6) },
        ],
        patterns: [pattern({ severity: 'blocked' })],
        quizzes: [{ score: 0.4, questionsAnswered: 5, completedAt: daysAgo(1) }],
      }),
      NOW,
    );

    expect(brief.focus[0]!.name).toBe('RAG pipeline');
    expect(brief.steps[0]!.action).toBe('ask_tutor');
    expect(brief.steps[0]!.concepts).toEqual(['RAG pipeline']);
  });

  /**
   * The dashboard card and the Tutor are answering the same question. If they
   * disagree the learner has been given two next actions, which is none.
   */
  it('leads with the active recommendation when the system already made one', () => {
    const brief = buildStudyBrief(
      input({
        concepts: [{ conceptId: 'c1', name: 'Tokens', mastery: mastery(0.3, 4) }],
        quizzes: [{ score: 0.4, questionsAnswered: 5, completedAt: daysAgo(1) }],
        activeRecommendation: {
          title: 'Revisit Tokens',
          body: 'You have missed questions on Tokens more than once.',
          action: 'review_material',
        },
      }),
      NOW,
    );

    expect(brief.steps[0]!.label).toBe('Revisit Tokens');
  });

  it('always has a next step, whatever the state', () => {
    for (const state of [
      input({ materials: [] }),
      input(),
      input({ concepts: [{ conceptId: 'c1', name: 'Tokens', mastery: mastery(0.95, 8) }], quizzes: [{ score: 1, questionsAnswered: 5, completedAt: daysAgo(1) }] }),
    ]) {
      expect(buildStudyBrief(state, NOW).steps.length).toBeGreaterThan(0);
    }
  });
});

describe('renderStudyBrief', () => {
  const brief = buildStudyBrief(
    input({
      concepts: [{ conceptId: 'c1', name: 'Tokens', mastery: mastery(0.3, 4) }],
      quizzes: [{ score: 0.4, questionsAnswered: 5, completedAt: daysAgo(1) }],
    }),
    NOW,
  );
  const text = renderStudyBrief(brief);

  it('is a complete answer on its own, in the three-part shape', () => {
    expect(text).toContain('**Where you are**');
    expect(text).toContain("**How you're doing**");
    expect(text).toContain('**What to do next**');
    expect(text).toMatch(/^1\. /m);
  });
});
