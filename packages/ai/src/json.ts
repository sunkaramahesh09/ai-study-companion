import type { ZodType } from 'zod';
import { InvalidOutputError, type GenerationProvider, type GenerationRequest } from './types.ts';

/**
 * Extracts a JSON object from a model response.
 *
 * Even in JSON mode, Groq's output is not schema-locked the way Gemini's is
 * (CLAUDE.md). In practice responses can arrive wrapped in ```json fences or
 * with a sentence of preamble, so this recovers the object rather than failing
 * on formatting the model was never actually promised to avoid.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  // Fall back to the outermost braces, for a response with prose around it.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);

  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) return trimmed.slice(firstArr, lastArr + 1);

  return trimmed;
}

export type GenerateJsonOptions<T> = {
  schema: ZodType<T>;
  /** Human-readable schema description, embedded in the prompt. */
  schemaHint: string;
  /** Re-ask once with the validation errors appended. Defaults to true. */
  repair?: boolean;
};

/**
 * Generates and VALIDATES structured output.
 *
 * This is the enforcement point for a stated PRD requirement (§8): AI-generated
 * structured data must be validated before it is persisted or used to change
 * application state. Callers receive a parsed, schema-checked value or an
 * exception — never an unchecked object.
 *
 * Do not soften this into "validate and patch up what's missing". A question
 * with a fabricated correct_index or a grade with an invented score is worse
 * than a failed generation, because it silently corrupts mastery data.
 */
export async function generateJson<T>(
  provider: GenerationProvider,
  request: GenerationRequest,
  options: GenerateJsonOptions<T>,
): Promise<{ value: T; raw: string; usedFallback: boolean; model: string }> {
  const { schema, schemaHint, repair = true } = options;

  const system =
    `${request.system}\n\n` +
    `Respond with a single JSON object and nothing else. No prose, no code fences.\n` +
    `It must match this schema exactly:\n${schemaHint}`;

  const first = await provider.generate({ ...request, system, json: true });
  const firstParse = tryParse(first.text, schema);
  if (firstParse.ok) {
    return { value: firstParse.value, raw: first.text, usedFallback: first.usedFallback, model: first.model };
  }

  if (!repair) {
    throw new InvalidOutputError(
      `Model output failed schema validation: ${firstParse.error}`,
      first.text,
    );
  }

  // One repair attempt, showing the model exactly what was wrong. A second
  // failure means something is structurally off, and burning more of an 8000
  // TPM budget on further retries is not worth it.
  const second = await provider.generate({
    ...request,
    system,
    json: true,
    messages: [
      ...request.messages,
      { role: 'assistant', content: first.text },
      {
        role: 'user',
        content:
          `That response failed validation: ${firstParse.error}\n` +
          `Return corrected JSON matching the schema. Output only the JSON object.`,
      },
    ],
  });

  const secondParse = tryParse(second.text, schema);
  if (secondParse.ok) {
    return { value: secondParse.value, raw: second.text, usedFallback: second.usedFallback, model: second.model };
  }

  throw new InvalidOutputError(
    `Model output failed schema validation twice. Last error: ${secondParse.error}`,
    second.text,
  );
}

function tryParse<T>(
  text: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    return { ok: false, error: `not valid JSON (${(error as Error).message})` };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: issues };
  }
  return { ok: true, value: result.data };
}
