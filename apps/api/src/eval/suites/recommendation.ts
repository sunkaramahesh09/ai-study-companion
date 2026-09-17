import { allTriggers, evaluateTriggers, type ProjectSnapshot } from '@asc/shared';
import { generateRecommendationText } from '../../lib/recommendations.ts';
import type { EvalCase } from '../types.ts';

/**
 * Recommendations: relevance, actionability and alignment with learner state
 * (PRD §14).
 *
 * The *decision* is deterministic (task 14), so its evaluation is exact: given
 * a learner state, exactly one rule should fire and it should be the right one.
 * Only the sentence is generated, so only the sentence is evaluated by reading
 * what the model produced.
 */

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

const baseSnapshot = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  hasMaterials: true,
  readyMaterials: 2,
  concepts: [],
  patterns: [],
  lastQuizAt: hoursAgo(2),
  lastQuizScore: 0.8,
  lastActivityAt: hoursAgo(1),
  activeRecommendations: [],
  ...over,
});

export const recommendationCases: EvalCase[] = [
  {
    id: 'recommendation.fires-the-right-rule-for-the-state',
    suite: 'recommendation',
    intent:
      'The recommendation matches the learner state that produced it. This is the whole claim that recommendations are grounded in evidence rather than vibes.',
    async run() {
      const scenarios = [
        {
          name: 'no material yet',
          snapshot: baseSnapshot({ hasMaterials: false, readyMaterials: 0, lastQuizAt: null, lastQuizScore: null }),
          expect: 'material_ready',
          expectAction: 'upload_material',
        },
        {
          name: 'a genuinely weak concept',
          snapshot: baseSnapshot({
            concepts: [
              { conceptId: 'a', name: 'Osmosis', mastery: { score: 0.2, evidenceCount: 6, lastEvidenceAt: hoursAgo(3) } },
              { conceptId: 'b', name: 'Enzymes', mastery: { score: 0.85, evidenceCount: 6, lastEvidenceAt: hoursAgo(3) } },
            ],
          }),
          expect: 'weak_concept',
          expectConcept: 'Osmosis',
        },
        {
          name: 'untouched for a week',
          snapshot: baseSnapshot({
            lastActivityAt: daysAgo(9),
            lastQuizAt: daysAgo(9),
            concepts: [
              { conceptId: 'a', name: 'Osmosis', mastery: { score: 0.7, evidenceCount: 6, lastEvidenceAt: daysAgo(9) } },
            ],
          }),
          expect: 'stale_project',
        },
      ];

      const results = scenarios.map((s) => {
        const trigger = evaluateTriggers(s.snapshot, now);
        return {
          scenario: s.name,
          fired: trigger?.trigger ?? null,
          expected: s.expect,
          conceptName: trigger?.conceptName ?? null,
          action: trigger?.action ?? null,
          ok:
            trigger?.trigger === s.expect &&
            (!s.expectConcept || trigger?.conceptName === s.expectConcept) &&
            (!s.expectAction || trigger?.action === s.expectAction),
          // Every recommendation must carry the evidence that produced it,
          // or it cannot be explained to the learner or audited later.
          hasEvidence: Object.keys(trigger?.evidence ?? {}).length > 0,
        };
      });

      const good = results.filter((r) => r.ok && r.hasEvidence).length;
      return {
        passed: good === scenarios.length,
        score: good / scenarios.length,
        detail: { good, of: scenarios.length, results },
      };
    },
  },
  {
    id: 'recommendation.does-not-raise-an-alarm-when-nothing-is-wrong',
    suite: 'recommendation',
    intent:
      'A learner doing well gets a low-priority nudge to keep going, never a weakness alert. And a weakness already raised is not repeated inside its cooldown.',
    async run() {
      const healthy = baseSnapshot({
        concepts: [
          { conceptId: 'a', name: 'Osmosis', mastery: { score: 0.82, evidenceCount: 8, lastEvidenceAt: hoursAgo(2) } },
          { conceptId: 'b', name: 'Enzymes', mastery: { score: 0.79, evidenceCount: 7, lastEvidenceAt: hoursAgo(2) } },
        ],
      });

      const weakButAlreadyTold = baseSnapshot({
        concepts: [
          { conceptId: 'a', name: 'Osmosis', mastery: { score: 0.2, evidenceCount: 6, lastEvidenceAt: hoursAgo(3) } },
        ],
        activeRecommendations: [{ trigger: 'weak_concept', conceptId: 'a', createdAt: hoursAgo(1) }],
      });

      const healthyTrigger = evaluateTriggers(healthy, now);
      const cooledTrigger = evaluateTriggers(weakButAlreadyTold, now);

      const checks = {
        // The PRD's question is "what should I do next?", so a healthy learner
        // still gets an answer — it just must not be a weakness alert. This
        // case originally asserted silence, which was wrong about the design:
        // the low-priority "keep going" nudge is deliberate.
        healthyLearnerIsNotAlarmed:
          healthyTrigger !== null &&
          healthyTrigger.trigger !== 'weak_concept' &&
          healthyTrigger.trigger !== 'repeated_mistake',
        healthyRecommendationIsLowPriority: (healthyTrigger?.priority ?? 100) <= 30,
        // The rule must still FIRE — the cooldown is what suppresses it. If
        // the rule stopped firing, the cooldown would be untestable.
        weaknessRuleStillFires: allTriggers(weakButAlreadyTold, now).some((t) => t.trigger === 'weak_concept'),
        cooldownSuppressesTheRepeat: cooledTrigger?.trigger !== 'weak_concept',
      };

      const passedCount = Object.values(checks).filter(Boolean).length;
      return {
        passed: passedCount === Object.keys(checks).length,
        score: null,
        detail: {
          checks,
          healthy: { trigger: healthyTrigger?.trigger ?? null, priority: healthyTrigger?.priority ?? null },
          withinCooldown: cooledTrigger?.trigger ?? null,
          rulesFiring: allTriggers(weakButAlreadyTold, now).map((t) => t.trigger),
        },
      };
    },
  },
  {
    id: 'recommendation.sentence-is-readable-and-actionable',
    suite: 'recommendation',
    intent:
      'The generated wording speaks to the learner and never leaks internal field names. A live recommendation once read "a high error rate and a blocked severity level".',
    async run({ userId, projectId }) {
      const trigger = evaluateTriggers(
        baseSnapshot({
          concepts: [
            { conceptId: 'a', name: 'Osmosis', mastery: { score: 0.22, evidenceCount: 7, lastEvidenceAt: hoursAgo(3) } },
          ],
        }),
        now,
      );
      if (!trigger) {
        return { passed: false, score: 0, detail: { error: 'no trigger fired, so no sentence to evaluate' } };
      }

      const { text, generated } = await generateRecommendationText({
        trigger,
        projectName: 'Biology',
        goal: 'Pass a first-year biology exam',
        userId,
        projectId,
      });

      const body = `${text.title} ${text.body}`;
      const jargon = ['severity', 'error rate', 'trigger', 'mastery score', 'evidence_count', 'conceptId', 'blocked', 'null', 'undefined']
        .filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body));

      const checks = {
        mentionsTheConcept: /osmosis/i.test(body),
        addressesTheLearner: /\byou\b|\byour\b/i.test(body),
        noJargon: jargon.length === 0,
        noMetaOpener: !/^(the evidence shows|based on your (results|data))/i.test(text.body.trim()),
        reasonableLength: text.body.length >= 20 && text.body.length <= 600,
        notShouting: !text.body.includes('!'),
      };

      const passedCount = Object.values(checks).filter(Boolean).length;
      return {
        passed: passedCount === Object.keys(checks).length,
        score: passedCount / Object.keys(checks).length,
        detail: { checks, jargon, generated, title: text.title, body: text.body },
      };
    },
  },
];
