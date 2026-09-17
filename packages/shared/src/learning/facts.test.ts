import { describe, expect, it } from 'vitest';
import { decaySalience, selectFacts, type LearnerFact } from './facts.ts';

const NOW = new Date('2026-09-17T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const fact = (over: Partial<LearnerFact> & Pick<LearnerFact, 'kind' | 'content'>): LearnerFact => ({
  salience: 0.6,
  lastSeenAt: daysAgo(1),
  ...over,
});

describe('selectFacts', () => {
  it('sends a weakness only when the question is about it', () => {
    const facts = [
      fact({ kind: 'weakness', content: 'Confuses L1 and L2 penalties.', conceptName: 'Regularisation' }),
      fact({ kind: 'weakness', content: 'Struggles with kernel sizes.', conceptName: 'Convolution' }),
    ];
    const chosen = selectFacts(facts, { question: 'How does regularisation prevent overfitting?', now: NOW });
    expect(chosen.facts).toHaveLength(1);
    expect(chosen.facts[0]!.conceptName).toBe('Regularisation');
  });

  it('drops every topic-specific fact when none is relevant', () => {
    // The failure this prevents: opening an answer about convolution by
    // mentioning an unrelated weakness, which reads as a non-sequitur and
    // spends tokens that should have gone to evidence.
    const facts = [
      fact({ kind: 'weakness', content: 'Confuses L1 and L2.', conceptName: 'Regularisation' }),
      fact({ kind: 'mistake_pattern', content: 'Misreads negative signs.', conceptName: 'Backpropagation' }),
    ];
    const chosen = selectFacts(facts, { question: 'What is a transformer?', now: NOW });
    expect(chosen.facts).toHaveLength(0);
  });

  it('always keeps a goal or a stated preference', () => {
    // These shape HOW to explain, whatever the topic is.
    const facts = [
      fact({ kind: 'goal', content: 'Preparing for a final exam in three weeks.' }),
      fact({ kind: 'preference', content: 'Learns best from worked examples.' }),
      fact({ kind: 'weakness', content: 'Confuses L1 and L2.', conceptName: 'Regularisation' }),
    ];
    const chosen = selectFacts(facts, { question: 'What is a transformer?', now: NOW });
    expect(chosen.facts.map((f) => f.kind).sort()).toEqual(['goal', 'preference']);
  });

  it('matches on the retrieved evidence, not only the question', () => {
    // "Explain this more simply" names no concept; the sources do.
    const facts = [fact({ kind: 'weakness', content: 'Shaky on chain rule.', conceptName: 'Backpropagation' })];
    const chosen = selectFacts(facts, {
      question: 'Explain that more simply.',
      evidence: 'Backpropagation applies the chain rule layer by layer.',
      now: NOW,
    });
    expect(chosen.facts).toHaveLength(1);
  });

  it('requires every significant term of a multi-word concept', () => {
    // "gradient" alone must not pull in a fact about gradient descent.
    const facts = [fact({ kind: 'weakness', content: 'Picks bad step sizes.', conceptName: 'Gradient descent' })];
    expect(selectFacts(facts, { question: 'What is a gradient?', now: NOW }).facts).toHaveLength(0);
    expect(selectFacts(facts, { question: 'How does gradient descent converge?', now: NOW }).facts).toHaveLength(1);
  });

  it('matches across singular and plural', () => {
    const facts = [fact({ kind: 'weakness', content: 'Confuses layer types.', conceptName: 'Neural networks' })];
    expect(selectFacts(facts, { question: 'How does a neural network learn?', now: NOW }).facts).toHaveLength(1);
  });

  it('forgets a stale observation', () => {
    // "Currently weak on this" is a claim about the present. Repeating it
    // months later is likely wrong in the direction that damages trust.
    const stale = fact({
      kind: 'weakness', content: 'Confuses L1 and L2.', conceptName: 'Regularisation',
      salience: 0.5, lastSeenAt: daysAgo(40),
    });
    const chosen = selectFacts([stale], { question: 'Explain regularisation.', now: NOW });
    expect(chosen.facts).toHaveLength(0);
  });

  it('keeps a re-observed fact that a stale one would have lost to', () => {
    const facts = [
      fact({ kind: 'weakness', content: 'Old worry.', conceptName: 'Regularisation', salience: 0.9, lastSeenAt: daysAgo(35) }),
      fact({ kind: 'weakness', content: 'Fresh worry.', conceptName: 'Regularisation', salience: 0.5, lastSeenAt: daysAgo(1) }),
    ];
    const chosen = selectFacts(facts, { question: 'Explain regularisation.', now: NOW, limit: 1 });
    expect(chosen.facts[0]!.content).toBe('Fresh worry.');
  });

  it('respects the limit, ranking a relevant fact above a merely applicable one', () => {
    // A weakness in the very concept being asked about outranks a generic
    // preference, even a more salient one. Relevance is the point.
    const facts = [
      fact({ kind: 'goal', content: 'Exam in three weeks.', salience: 0.4 }),
      fact({ kind: 'preference', content: 'Prefers examples.', salience: 0.9 }),
      fact({ kind: 'weakness', content: 'Confuses penalties.', conceptName: 'Regularisation', salience: 0.7 }),
    ];
    const chosen = selectFacts(facts, { question: 'Explain regularisation.', now: NOW, limit: 2 });
    expect(chosen.facts).toHaveLength(2);
    expect(chosen.facts[0]!.content).toBe('Confuses penalties.');
    expect(chosen.facts[1]!.content).toBe('Prefers examples.');
  });

  it('is deterministic for tied scores', () => {
    const facts = [
      fact({ kind: 'preference', content: 'Beta.', salience: 0.5, lastSeenAt: null }),
      fact({ kind: 'preference', content: 'Alpha.', salience: 0.5, lastSeenAt: null }),
    ];
    const a = selectFacts(facts, { question: 'Anything.', now: NOW });
    const b = selectFacts([...facts].reverse(), { question: 'Anything.', now: NOW });
    expect(a.facts.map((f) => f.content)).toEqual(b.facts.map((f) => f.content));
    expect(a.facts[0]!.content).toBe('Alpha.');
  });

  it('handles an empty profile', () => {
    expect(selectFacts([], { question: 'Explain regularisation.', now: NOW }).facts).toEqual([]);
  });

  it('explains its own choices', () => {
    // The admin view and the eval suite both need to know why a fact was used.
    const facts = [fact({ kind: 'weakness', content: 'Confuses penalties.', conceptName: 'Regularisation' })];
    const { scores } = selectFacts(facts, { question: 'Explain regularisation.', now: NOW });
    expect(scores).toHaveLength(1);
    expect(scores[0]!.relevant).toBe(true);
    expect(scores[0]!.score).toBeGreaterThan(0);
  });
});

describe('decaySalience', () => {
  it('halves over the half-life', () => {
    expect(decaySalience({ kind: 'weakness', content: 'x', salience: 0.8, lastSeenAt: daysAgo(10) }, NOW)).toBeCloseTo(0.4, 3);
  });

  it('leaves a fact with no timestamp alone', () => {
    expect(decaySalience({ kind: 'goal', content: 'x', salience: 0.8, lastSeenAt: null }, NOW)).toBe(0.8);
  });

  it('never decays into the future', () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(decaySalience({ kind: 'goal', content: 'x', salience: 0.8, lastSeenAt: future }, NOW)).toBe(0.8);
  });
});
