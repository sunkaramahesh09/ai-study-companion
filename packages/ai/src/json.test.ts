import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractJson, generateJson } from './json.ts';
import { InvalidOutputError, type GenerationProvider, type GenerationResult } from './types.ts';

const QuestionSchema = z.object({
  prompt: z.string().min(1),
  options: z.array(z.string()).length(4),
  correctIndex: z.number().int().min(0).max(3),
});

function stubProvider(...responses: string[]): GenerationProvider & { calls: number } {
  let i = 0;
  const p = {
    calls: 0,
    async generate(): Promise<GenerationResult> {
      const text = responses[Math.min(i++, responses.length - 1)]!;
      p.calls++;
      return {
        text,
        model: 'stub',
        usedFallback: false,
        usage: { promptTokens: 10, completionTokens: 10, reasoningTokens: 0, totalTokens: 20 },
        latencyMs: 1,
        attempts: 1,
      };
    },
  };
  return p;
}

describe('extractJson', () => {
  it('passes plain JSON through', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a ```json fence', () => {
    // JSON mode is requested, but Groq does not guarantee schema-locked output
    // the way Gemini does, so fences do show up.
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('recovers an object surrounded by prose', () => {
    expect(extractJson('Sure! Here it is:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('recovers a top-level array', () => {
    expect(extractJson('Here: [1,2,3] done')).toBe('[1,2,3]');
  });
});

describe('generateJson', () => {
  const req = { feature: 'question_generation' as const, system: 'sys', messages: [{ role: 'user' as const, content: 'go' }] };
  const opts = { schema: QuestionSchema, schemaHint: '{...}' };

  it('returns a parsed, validated value', async () => {
    const provider = stubProvider(
      JSON.stringify({ prompt: 'What is X?', options: ['a', 'b', 'c', 'd'], correctIndex: 2 }),
    );
    const { value } = await generateJson(provider, req, opts);
    expect(value.correctIndex).toBe(2);
    expect(provider.calls).toBe(1);
  });

  it('repairs once when the first response violates the schema', async () => {
    const provider = stubProvider(
      JSON.stringify({ prompt: 'What is X?', options: ['a', 'b'], correctIndex: 9 }), // wrong
      JSON.stringify({ prompt: 'What is X?', options: ['a', 'b', 'c', 'd'], correctIndex: 1 }),
    );
    const { value } = await generateJson(provider, req, opts);
    expect(value.options).toHaveLength(4);
    expect(provider.calls).toBe(2);
  });

  it('throws rather than returning unvalidated data after two failures', async () => {
    // Persisting a question with a fabricated correctIndex would silently
    // corrupt mastery scoring. A failed generation is strictly better.
    const provider = stubProvider(JSON.stringify({ prompt: 'x', options: ['a'], correctIndex: 7 }));
    await expect(generateJson(provider, req, opts)).rejects.toBeInstanceOf(InvalidOutputError);
    expect(provider.calls).toBe(2);
  });

  it('rejects non-JSON entirely', async () => {
    const provider = stubProvider('I am unable to produce JSON right now.');
    await expect(generateJson(provider, req, opts)).rejects.toThrow(/schema validation/i);
  });

  it('does not retry when repair is disabled', async () => {
    const provider = stubProvider('{"nope":true}');
    await expect(generateJson(provider, req, { ...opts, repair: false })).rejects.toBeInstanceOf(
      InvalidOutputError,
    );
    expect(provider.calls).toBe(1);
  });

  it('puts the schema in the prompt, since JSON mode alone does not enforce it', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: JSON.stringify({ prompt: 'p', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }),
      model: 'stub', usedFallback: false,
      usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 },
      latencyMs: 1, attempts: 1,
    });
    await generateJson({ generate }, req, { schema: QuestionSchema, schemaHint: 'SCHEMA_MARKER' });
    const sent = generate.mock.calls[0]![0] as { system: string; json: boolean };
    expect(sent.system).toContain('SCHEMA_MARKER');
    expect(sent.json).toBe(true);
  });
});
