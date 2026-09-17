import { describe, expect, it } from 'vitest';
import { GradeSchema, OpenQuestionSchema, sanitiseGrade, type Grade } from '../lib/grading.ts';

const validQuestion = {
  prompt: 'Explain how gradient descent finds a minimum, and why the learning rate matters.',
  expectedPoints: [
    'It steps in the direction opposite the gradient',
    'The learning rate controls step size',
    'Too large a rate can overshoot the minimum',
  ],
};

const validGrade: Grade = {
  score: 0.6,
  understood: ['You correctly described stepping against the gradient'],
  missing: ['You did not mention what happens when the learning rate is too large'],
  feedback: 'Good start on the mechanism. Next, look at how step size affects convergence.',
};

describe('OpenQuestionSchema', () => {
  it('accepts a well-formed open question', () => {
    expect(OpenQuestionSchema.safeParse(validQuestion).success).toBe(true);
  });

  it('requires a rubric of at least two points', () => {
    // One point is not a rubric; it cannot produce partial credit, which is the
    // whole reason open questions are worth their grading cost.
    expect(OpenQuestionSchema.safeParse({ ...validQuestion, expectedPoints: ['only one'] }).success).toBe(false);
    expect(OpenQuestionSchema.safeParse({ ...validQuestion, expectedPoints: [] }).success).toBe(false);
  });

  it('caps the rubric so grading stays tractable', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Point number ${i} about the topic`);
    expect(OpenQuestionSchema.safeParse({ ...validQuestion, expectedPoints: many }).success).toBe(false);
  });

  it('rejects a prompt too short to need a written answer', () => {
    expect(OpenQuestionSchema.safeParse({ ...validQuestion, prompt: 'Why?' }).success).toBe(false);
  });
});

describe('GradeSchema', () => {
  it('accepts a well-formed grade', () => {
    expect(GradeSchema.safeParse(validGrade).success).toBe(true);
  });

  it('rejects a score outside 0..1', () => {
    // An out-of-range score would be written straight into mastery.
    expect(GradeSchema.safeParse({ ...validGrade, score: 1.4 }).success).toBe(false);
    expect(GradeSchema.safeParse({ ...validGrade, score: -0.2 }).success).toBe(false);
  });

  it('requires feedback substantial enough to teach', () => {
    // The PRD asks for feedback that explains rather than "returning only a
    // numerical score" (§9).
    expect(GradeSchema.safeParse({ ...validGrade, feedback: 'Good.' }).success).toBe(false);
  });

  it('requires the understood and missing arrays to be present', () => {
    const { understood: _u, ...noUnderstood } = validGrade;
    expect(GradeSchema.safeParse(noUnderstood).success).toBe(false);
  });

  it('allows one of them to be empty', () => {
    expect(GradeSchema.safeParse({ ...validGrade, missing: [] }).success).toBe(true);
    expect(GradeSchema.safeParse({ ...validGrade, understood: [] }).success).toBe(true);
  });
});

describe('sanitiseGrade — coherence, not just shape', () => {
  it('leaves a coherent grade alone', () => {
    expect(sanitiseGrade(validGrade, 3).score).toBe(0.6);
  });

  it('pulls down full marks awarded alongside listed gaps', () => {
    // Self-contradictory. The gaps are specific; the number is a guess, so
    // trust the gaps.
    const out = sanitiseGrade({ ...validGrade, score: 1, missing: ['A missing point', 'Another gap'] }, 3);
    expect(out.score).toBeLessThan(1);
  });

  it('raises a zero awarded alongside things the learner got right', () => {
    const out = sanitiseGrade({ ...validGrade, score: 0, understood: ['You explained the mechanism'], missing: [] }, 3);
    expect(out.score).toBeGreaterThan(0);
  });

  it('clamps a score that somehow escaped the schema', () => {
    expect(sanitiseGrade({ ...validGrade, score: 3 } as Grade, 3).score).toBeLessThanOrEqual(1);
    expect(sanitiseGrade({ ...validGrade, score: -5 } as Grade, 3).score).toBeGreaterThanOrEqual(0);
  });

  it('deduplicates repeated feedback points', () => {
    const out = sanitiseGrade(
      { ...validGrade, understood: ['Same point', 'same point ', 'SAME POINT'] },
      3,
    );
    expect(out.understood).toHaveLength(1);
  });

  it('keeps full marks when nothing is listed as missing', () => {
    const out = sanitiseGrade({ ...validGrade, score: 1, missing: [] }, 3);
    expect(out.score).toBe(1);
  });

  it('is deterministic', () => {
    expect(sanitiseGrade(validGrade, 3)).toEqual(sanitiseGrade(validGrade, 3));
  });
});
