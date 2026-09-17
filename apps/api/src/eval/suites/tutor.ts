import { containsNormalised } from '@asc/shared';
import { askTutor } from '../../lib/tutor.ts';
import { GROUND_TRUTH } from '../fixture.ts';
import type { EvalCase } from '../types.ts';

/**
 * Tutor: accuracy, groundedness, citation correctness and unsupported-question
 * handling (PRD §14). This is the suite the PRD singles out.
 *
 * Grading is rule-based against the fixture's known page layout rather than
 * model-based. A model judging another model's citation would be both more
 * expensive and less trustworthy than checking whether the cited page is the
 * page the fact is actually printed on.
 */
export const tutorCases: EvalCase[] = [
  {
    id: 'tutor.cites-the-page-the-fact-is-on',
    suite: 'tutor',
    intent:
      'An answer is not merely decorated with citations — the page it cites is the page the answer is actually found on.',
    async run({ db, projectId, userId }) {
      const results = [];
      for (const truth of GROUND_TRUTH) {
        const answer = await askTutor(db, { userId, projectId, question: truth.question });
        const pages = answer.citations.map((c) => c.pageNumber);
        results.push({
          question: truth.question,
          expectedPage: truth.page,
          citedPages: pages,
          grounded: answer.grounded,
          citesCorrectPage: pages.includes(truth.page),
          // Groundedness and correctness are separate failures. An answer can
          // cite the right page and still state the wrong number.
          //
          // Compared with typographic normalisation: models write "thirty‑two"
          // with a non-breaking hyphen, and a literal match would fail a
          // correct answer. That is the worst kind of false result — a red
          // evaluation for working behaviour. See D-057.
          statesTheFact: truth.mustContain.some((needle) => containsNormalised(answer.answer, needle)),
          answer: answer.answer.slice(0, 300),
        });
      }

      const fullyCorrect = results.filter((r) => r.grounded && r.citesCorrectPage && r.statesTheFact).length;
      return {
        passed: fullyCorrect === GROUND_TRUTH.length,
        score: fullyCorrect / GROUND_TRUTH.length,
        detail: {
          fullyCorrect,
          of: GROUND_TRUTH.length,
          citedCorrectPage: results.filter((r) => r.citesCorrectPage).length,
          statedTheFact: results.filter((r) => r.statesTheFact).length,
          results,
        },
      };
    },
  },
  {
    id: 'tutor.refuses-what-the-material-does-not-cover',
    suite: 'tutor',
    intent:
      'A question outside the material yields a refusal, not a fabrication — even when the model plainly knows the answer.',
    async run({ db, projectId, userId }) {
      const cases = [
        { question: 'Who won the 1998 football world cup?', mustNotContain: ['france', 'brazil'] },
        { question: 'What is the boiling point of mercury?', mustNotContain: ['357', '629'] },
      ];

      const results = [];
      for (const c of cases) {
        const answer = await askTutor(db, { userId, projectId, question: c.question });
        const leaked = c.mustNotContain.filter((n) => containsNormalised(answer.answer, n));
        results.push({
          question: c.question,
          grounded: answer.grounded,
          reason: answer.reason,
          // The strong assertion: it did not answer from general knowledge.
          // A refusal that still slips the answer in is not a refusal.
          leakedGeneralKnowledge: leaked,
          answer: answer.answer.slice(0, 200),
        });
      }

      const clean = results.filter((r) => !r.grounded && r.leakedGeneralKnowledge.length === 0).length;
      return {
        passed: clean === cases.length,
        score: clean / cases.length,
        detail: { clean, of: cases.length, results },
      };
    },
  },
  {
    id: 'tutor.refusal-is-free-and-explains-itself',
    suite: 'tutor',
    intent:
      'Refusing costs no tokens and names what is missing, so the learner knows whether to upload something or rephrase.',
    async run({ db, userId }) {
      const { data: space } = await db
        .from('spaces').insert({ user_id: userId, name: 'Refusal eval' }).select('id').single();
      const { data: project } = await db
        .from('projects').insert({ space_id: space!.id, user_id: userId, name: 'No material' }).select('id').single();

      const answer = await askTutor(db, {
        userId,
        projectId: project!.id as string,
        question: 'Explain cellular respiration.',
      });

      return {
        passed:
          !answer.grounded &&
          answer.reason === 'no_materials' &&
          // A deterministic template, so no model was called at all.
          answer.model === null &&
          /upload/i.test(answer.answer),
        score: null,
        detail: {
          reason: answer.reason,
          model: answer.model,
          spentTokens: answer.model !== null,
          answer: answer.answer,
        },
      };
    },
  },
];
