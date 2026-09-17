import { describe, expect, it } from 'vitest';
import { McqSchema } from '../lib/questions.ts';

const valid = {
  prompt: 'Which statement best describes gradient descent?',
  options: [
    'It maximises the loss function',
    'It iteratively minimises a loss function',
    'It requires no learning rate',
    'It only works on linear models',
  ],
  correctIndex: 1,
  explanation: 'Gradient descent steps against the gradient to reduce loss.',
};

describe('McqSchema — the gate before a question reaches a learner', () => {
  it('accepts a well-formed question', () => {
    expect(McqSchema.safeParse(valid).success).toBe(true);
  });

  it('requires exactly four options', () => {
    // The UI renders four, and correctIndex is bounded to 0..3.
    expect(McqSchema.safeParse({ ...valid, options: valid.options.slice(0, 3) }).success).toBe(false);
    expect(McqSchema.safeParse({ ...valid, options: [...valid.options, 'E'] }).success).toBe(false);
  });

  it('rejects a correctIndex outside the options', () => {
    // The dangerous case: an out-of-range index would mark every answer wrong
    // and drive mastery down for a concept the learner may actually know.
    expect(McqSchema.safeParse({ ...valid, correctIndex: 4 }).success).toBe(false);
    expect(McqSchema.safeParse({ ...valid, correctIndex: -1 }).success).toBe(false);
  });

  it('rejects a non-integer correctIndex', () => {
    expect(McqSchema.safeParse({ ...valid, correctIndex: 1.5 }).success).toBe(false);
  });

  it('rejects duplicate options', () => {
    // Two identical options make the question unanswerable and mark a correct
    // choice wrong depending on which the learner clicked.
    const dupes = ['Same answer', 'Same answer', 'Other', 'Another'];
    expect(McqSchema.safeParse({ ...valid, options: dupes }).success).toBe(false);
  });

  it('treats options differing only by case or padding as duplicates', () => {
    const dupes = ['Answer', '  answer ', 'Other', 'Another'];
    expect(McqSchema.safeParse({ ...valid, options: dupes }).success).toBe(false);
  });

  it('rejects an empty option', () => {
    expect(McqSchema.safeParse({ ...valid, options: ['a', '', 'c', 'd'] }).success).toBe(false);
  });

  it('rejects a prompt too short to be a question', () => {
    expect(McqSchema.safeParse({ ...valid, prompt: 'Why?' }).success).toBe(false);
  });

  it('requires an explanation, which is what makes feedback teach', () => {
    expect(McqSchema.safeParse({ ...valid, explanation: undefined }).success).toBe(false);
    expect(McqSchema.safeParse({ ...valid, explanation: 'no' }).success).toBe(false);
  });

  it('trims whitespace rather than storing padded text', () => {
    const parsed = McqSchema.parse({ ...valid, prompt: `  ${valid.prompt}  ` });
    expect(parsed.prompt).toBe(valid.prompt);
  });

  it('rejects a completely malformed object', () => {
    expect(McqSchema.safeParse({}).success).toBe(false);
    expect(McqSchema.safeParse({ prompt: 'x'.repeat(20) }).success).toBe(false);
  });
});
