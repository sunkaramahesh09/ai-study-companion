import { RELEVANCE_THRESHOLD, retrieve } from '../../lib/retrieval.ts';
import type { EvalCase } from '../types.ts';

/**
 * Retrieval: relevance of retrieved content and source quality (PRD §14).
 *
 * Every case here is rule-based. Retrieval either returned the right passage
 * or it did not, and that is checkable against the fixture's known page
 * layout — asking a model to judge it would add cost, variance and no truth.
 */
export const retrievalCases: EvalCase[] = [
  {
    id: 'retrieval.on-topic-finds-right-page',
    suite: 'retrieval',
    intent: 'A question about a specific fact retrieves the page that actually contains it.',
    async run({ db, projectId }) {
      const probes = [
        { query: 'How much ATP does glycolysis and respiration produce?', page: 1 },
        { query: 'What does RuBisCO do in photosynthesis?', page: 2 },
        { query: 'How does the sodium potassium pump work?', page: 4 },
      ];

      const results = [];
      for (const probe of probes) {
        const r = await retrieve(db, projectId, probe.query, { matchCount: 3 });
        const pages = r.chunks.map((c) => c.pageNumber);
        results.push({
          query: probe.query,
          expectedPage: probe.page,
          pages,
          // Top-1 is the strict bar; being anywhere in the top 3 still counts
          // as usable, because the Tutor sees all of them.
          topIsCorrect: pages[0] === probe.page,
          containsCorrect: pages.includes(probe.page),
          bestDistance: r.bestDistance,
        });
      }

      const hits = results.filter((r) => r.containsCorrect).length;
      const topHits = results.filter((r) => r.topIsCorrect).length;
      return {
        passed: hits === probes.length,
        score: hits / probes.length,
        detail: { topHits, hits, of: probes.length, results },
      };
    },
  },
  {
    id: 'retrieval.off-topic-returns-nothing',
    suite: 'retrieval',
    intent:
      'Questions the material does not cover fall outside the relevance gate, so the Tutor is never handed irrelevant evidence to answer from.',
    async run({ db, projectId }) {
      const offTopic = [
        'Who won the 1998 football world cup?',
        'What is the capital of Mongolia?',
        'How do I refinance a mortgage?',
      ];

      const results = [];
      for (const query of offTopic) {
        const r = await retrieve(db, projectId, query, { matchCount: 3 });
        results.push({
          query,
          reason: r.reason,
          chunks: r.chunks.length,
          bestDistance: r.bestDistance,
          // The margin matters more than the verdict: a query that only just
          // failed the gate is a threshold one embedding change away from
          // passing it. See D-029.
          marginBelowThreshold:
            r.bestDistance === null ? null : Math.round((r.bestDistance - RELEVANCE_THRESHOLD) * 1000) / 1000,
        });
      }

      const rejected = results.filter((r) => r.chunks === 0).length;
      return {
        passed: rejected === offTopic.length,
        score: rejected / offTopic.length,
        detail: { rejected, of: offTopic.length, threshold: RELEVANCE_THRESHOLD, results },
      };
    },
  },
  {
    id: 'retrieval.reports-why-it-is-empty',
    suite: 'retrieval',
    intent:
      'An unindexed project is distinguished from an irrelevant question. Collapsing the two is what makes a RAG app feel broken.',
    async run({ db, userId }) {
      const { data: space } = await db
        .from('spaces').insert({ user_id: userId, name: 'Empty eval space' }).select('id').single();
      const { data: project } = await db
        .from('projects').insert({ space_id: space!.id, user_id: userId, name: 'Empty' }).select('id').single();

      const r = await retrieve(db, project!.id as string, 'What is cellular respiration?');
      return {
        passed: r.reason === 'no_materials' && r.chunks.length === 0,
        score: null,
        detail: { reason: r.reason, chunks: r.chunks.length, indexed: r.indexed },
      };
    },
  },
  {
    id: 'retrieval.chunks-carry-usable-provenance',
    suite: 'retrieval',
    intent:
      'Every retrieved chunk carries a real filename and a page number inside the document, so a citation can be followed back.',
    async run({ db, projectId }) {
      const r = await retrieve(db, projectId, 'enzymes and activation energy', { matchCount: 5 });
      const bad = r.chunks.filter(
        (c) =>
          !c.filename ||
          !Number.isInteger(c.pageNumber) ||
          c.pageNumber < 1 ||
          c.pageNumber > 4 ||
          c.content.trim().length === 0,
      );
      return {
        passed: r.chunks.length > 0 && bad.length === 0,
        score: r.chunks.length === 0 ? 0 : (r.chunks.length - bad.length) / r.chunks.length,
        detail: {
          retrieved: r.chunks.length,
          malformed: bad.length,
          sample: r.chunks.slice(0, 3).map((c) => ({ page: c.pageNumber, file: c.filename, chars: c.content.length })),
        },
      };
    },
  },
];
