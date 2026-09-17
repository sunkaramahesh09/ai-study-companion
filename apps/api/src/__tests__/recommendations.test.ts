import { describe, expect, it } from 'vitest';
import { RecommendationTextSchema, fallbackText, polish } from '../lib/recommendations.ts';
import type { RecommendationTrigger } from '@asc/shared';

const trigger = (over: Partial<RecommendationTrigger> = {}): RecommendationTrigger => ({
  trigger: 'repeated_mistake',
  conceptId: 'c1',
  conceptName: 'The Calvin cycle',
  action: 'review_material',
  priority: 90,
  evidence: { mistakes: 3, attempts: 4, errorRate: 0.75, severity: 'blocked' },
  ...over,
});

describe('polish', () => {
  it('strips stock meta-commentary mid-sentence', () => {
    // Two of three live recommendations opened this way despite an explicit
    // instruction not to (D-048).
    expect(polish('You are struggling. The evidence shows that re-reading will help.')).toBe(
      'You are struggling. Re-reading will help.',
    );
  });

  it('strips it at the start and re-capitalises', () => {
    expect(polish('The evidence shows you need more practice.')).toBe('You need more practice.');
  });

  it('handles the other phrasings', () => {
    expect(polish('Based on your results, you should review chapter 2.')).toBe('You should review chapter 2.');
    expect(polish('According to your data, this is weak.')).toBe('This is weak.');
  });

  it('leaves clean text untouched', () => {
    const clean = 'You scored zero on the last quiz. Re-read the material.';
    expect(polish(clean)).toBe(clean);
  });

  it('does not mangle a sentence that merely mentions evidence', () => {
    // "evidence" as a normal word must survive; only the stock opener goes.
    const text = 'Your answers are the evidence behind this estimate.';
    expect(polish(text)).toBe(text);
  });

  it('collapses the double space a strip leaves behind', () => {
    expect(polish('One. The evidence shows two.')).not.toMatch(/ {2}/);
  });
});

describe('fallbackText — used when generation fails', () => {
  it('names the concept for a repeated mistake', () => {
    // A recommendation the learner can act on beats no recommendation, and the
    // trigger already carries everything needed to be specific.
    const t = fallbackText(trigger());
    expect(t.title).toContain('Calvin cycle');
    expect(t.body).toContain('Calvin cycle');
  });

  it('produces valid text for every trigger type', () => {
    const triggers: RecommendationTrigger[] = [
      trigger(),
      trigger({ trigger: 'weak_concept', action: 'ask_tutor' }),
      trigger({ trigger: 'material_ready', action: 'upload_material', conceptName: null }),
      trigger({ trigger: 'material_ready', action: 'take_quiz', conceptName: null }),
      trigger({ trigger: 'stale_project', action: 'review_material', conceptName: null, evidence: { idleDays: 9 } }),
      trigger({ trigger: 'quiz_completed', action: 'take_quiz', conceptName: null }),
    ];
    for (const t of triggers) {
      expect(RecommendationTextSchema.safeParse(fallbackText(t)).success).toBe(true);
    }
  });

  it('never leaks internal jargon', () => {
    for (const t of [trigger(), trigger({ trigger: 'weak_concept', action: 'ask_tutor' })]) {
      const { title, body } = fallbackText(t);
      expect(`${title} ${body}`).not.toMatch(/severity|error rate|blocked|mastery score|trigger/i);
    }
  });

  it('copes with a missing concept name', () => {
    const t = fallbackText(trigger({ conceptName: null }));
    expect(RecommendationTextSchema.safeParse(t).success).toBe(true);
    expect(t.title).not.toContain('null');
  });
});

describe('RecommendationTextSchema', () => {
  it('rejects a title too long to scan on a dashboard', () => {
    expect(RecommendationTextSchema.safeParse({ title: 'x'.repeat(200), body: 'y'.repeat(50) }).success).toBe(false);
  });

  it('rejects a body too short to say anything useful', () => {
    expect(RecommendationTextSchema.safeParse({ title: 'Review this', body: 'Do it.' }).success).toBe(false);
  });
});
