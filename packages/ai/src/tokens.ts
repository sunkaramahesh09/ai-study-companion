/**
 * Token estimation for rate-limit reservations.
 *
 * Deliberately approximate. The limiter reserves an estimate and then settles
 * with the provider's actual usage (see RateLimiter), so this only has to be
 * close enough to stop a burst of concurrent calls overshooting — it is not an
 * accounting figure. Shipping a real tokenizer for a number that gets corrected
 * milliseconds later is not worth the dependency.
 *
 * ~4 characters per token is the standard rough ratio for English prose.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Reasoning multiplier applied to the completion allowance.
 *
 * gpt-oss models emit internal reasoning tokens that are billed as completion
 * tokens. Measured on a one-word answer: 27 of 37 completion tokens at default
 * effort, 8 of 18 at 'low' (D-016). Reserving only the visible answer length
 * would under-count by 2-3x and walk us straight into a 429.
 */
export function reasoningMultiplier(effort: 'low' | 'medium' | 'high' | undefined): number {
  switch (effort) {
    case 'low':
      return 1.5;
    case 'high':
      return 3.5;
    default:
      return 2.5;
  }
}

export function estimateRequestTokens(input: {
  system: string;
  messages: { content: string }[];
  maxTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
}): number {
  let prompt = estimateTokens(input.system);
  for (const m of input.messages) prompt += estimateTokens(m.content);
  // Per-message framing overhead the API adds on top of the raw text.
  prompt += input.messages.length * 4 + 8;

  // maxTokens is a ceiling, not a prediction. Assume ~60% of it is used, then
  // scale for reasoning.
  const completion = input.maxTokens * 0.6 * reasoningMultiplier(input.reasoningEffort);
  return Math.ceil(prompt + completion);
}

/**
 * Cost estimate in USD. Groq's gpt-oss tiers are free at the limits we use, so
 * this exists to make the admin cost view meaningful rather than to bill
 * anyone. Rates are per million tokens.
 */
const RATES: Record<string, { in: number; out: number }> = {
  'openai/gpt-oss-120b': { in: 0.15, out: 0.75 },
  'openai/gpt-oss-20b': { in: 0.1, out: 0.5 },
  'gemini-embedding-001': { in: 0.0, out: 0.0 },
};

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const rate = RATES[model];
  if (!rate) return 0;
  return (promptTokens / 1_000_000) * rate.in + (completionTokens / 1_000_000) * rate.out;
}
