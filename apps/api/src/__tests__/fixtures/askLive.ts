import type { FastifyInstance } from 'fastify';

/**
 * Asks the Tutor in a live test and insists on an answer-shaped response.
 *
 * `POST /api/tutor/ask` returns 503 `tutor_unavailable` when generation throws
 * — the provider is down, or returned something the layer above it rejected.
 * That body has no `message`, so a test that reads `r.message.content`
 * straight off the JSON dies with `Cannot read properties of undefined`
 * pointing at the assertion helper, which reads like the prompt-injection
 * boundary broke. It did not; the provider was unreachable for one call.
 *
 * So: one retry, because a single transient upstream failure is not evidence
 * about this project's behaviour, and then a hard failure that says which of
 * the two things went wrong. Never a skip — a Tutor that cannot answer is
 * still a red suite, just an honestly labelled one.
 *
 * The 503 path itself is a behaviour we test deliberately, against a stubbed
 * provider, in `providerFailure.test.ts`. It does not need a live outage.
 */

export type TutorReply = {
  conversationId: string;
  grounded: boolean;
  reason: string;
  mode: 'material' | 'progress' | null;
  message: {
    id: string;
    content: string;
    citations: { pageNumber: number; filename: string }[];
    grounded: boolean;
    mode: 'material' | 'progress' | null;
  };
  diagnostics: {
    retrieved: number;
    bestDistance: number | null;
    model: string;
    usedFallback: boolean;
    latencyMs: number;
    factsUsed: string[];
  };
};

const RETRY_DELAY_MS = 3_000;

export async function askTutorLive(
  app: FastifyInstance,
  headers: Record<string, string>,
  payload: { projectId: string; question: string; conversationId?: string },
): Promise<TutorReply> {
  let res = await app.inject({ method: 'POST', url: '/api/tutor/ask', headers, payload });

  if (res.statusCode === 503) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await app.inject({ method: 'POST', url: '/api/tutor/ask', headers, payload });
  }

  if (res.statusCode !== 200) {
    const body = res.json() as { error?: string; message?: string };
    const why =
      res.statusCode === 503
        ? 'the AI provider was unavailable for two consecutive calls — this is an upstream outage, not a Tutor behaviour failure'
        : `the route rejected the request (${body.error ?? 'no error code'})`;
    throw new Error(
      `Tutor did not answer "${payload.question.slice(0, 60)}": HTTP ${res.statusCode} — ${why}. ${body.message ?? ''}`.trim(),
    );
  }

  return res.json() as TutorReply;
}
