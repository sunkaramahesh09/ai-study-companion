import { generateJson } from '@asc/ai';
import type { ProjectSnapshot, RecommendationTrigger } from '@asc/shared';
import { evaluateTriggers } from '@asc/shared';
import { z } from 'zod';
import { generationProvider } from './ai.ts';

/**
 * Turning a trigger into a sentence.
 *
 * WHETHER to recommend, and WHAT about, is decided by `evaluateTriggers` in the
 * deterministic core (task 14). Only the wording is generated. That split is why
 * a recommendation is always explainable by the state that produced it, and why
 * the evaluation suite can check that the text matches that state.
 */

export const RecommendationTextSchema = z.object({
  /** Shown as the headline. Short enough to scan on a dashboard. */
  title: z.string().trim().min(8).max(80),
  /** Two or three sentences addressed to the learner, ending in an action. */
  body: z.string().trim().min(30).max(400),
});

export type RecommendationText = z.infer<typeof RecommendationTextSchema>;

export const RECOMMENDATION_SCHEMA_HINT = `{
  "title": "short headline, 8-80 chars",
  "body": "2-3 sentences to the learner ending in a concrete next action, 30-400 chars"
}`;

const ACTION_PHRASING: Record<string, string> = {
  review_material: 're-read the relevant part of their material',
  take_quiz: 'take a short quiz',
  ask_tutor: 'ask the Tutor to explain it',
  upload_material: 'upload a PDF to learn from',
};

/**
 * Deterministic fallback text.
 *
 * Used when generation fails or its output does not validate. A recommendation
 * the learner can act on beats no recommendation at all, and the trigger already
 * contains everything needed to say something specific — the model only makes it
 * read better. This is also why a generation failure does not fail the job.
 */
export function fallbackText(trigger: RecommendationTrigger): RecommendationText {
  const concept = trigger.conceptName;
  switch (trigger.trigger) {
    case 'repeated_mistake':
      return {
        title: `Revisit ${concept ?? 'a tricky concept'}`,
        body: `You've missed questions on ${concept ?? 'this concept'} more than once. Re-read that part of your material, then try another short quiz to check it has stuck.`,
      };
    case 'weak_concept':
      return {
        title: `${concept ?? 'One concept'} needs another look`,
        body: `Your answers suggest ${concept ?? 'this concept'} is the weakest area right now. Ask the Tutor to explain it in a different way, then test yourself on it.`,
      };
    case 'material_ready':
      return trigger.action === 'upload_material'
        ? {
            title: 'Add some material to learn from',
            body: 'This Project has no material yet. Upload a PDF and the Tutor will be able to answer from it, with citations back to the page.',
          }
        : {
            title: 'Test yourself on your material',
            body: 'Your material is processed and ready. Take a short quiz so the system can work out which concepts you already know and which need attention.',
          };
    case 'stale_project':
      return {
        title: 'Pick this Project back up',
        body: `It has been ${trigger.evidence.idleDays ?? 'several'} days since you worked on this. A short review of your material is the easiest way back in.`,
      };
    default:
      return {
        title: 'Keep going with another quiz',
        body: 'Your recent answers look solid. Another short quiz will sharpen the mastery estimates and show where to go next.',
      };
  }
}

/**
 * Writes the sentence for a trigger.
 *
 * The prompt receives the trigger's evidence as structured facts, not free text,
 * so the model is rephrasing a decision rather than making one. It cannot
 * recommend something the rules did not decide.
 */
/**
 * Removes stock meta-commentary the model reinserts however firmly the prompt
 * forbids it.
 *
 * "The evidence shows that..." appeared in two of three live recommendations
 * after an explicit instruction not to use it — the same stochastic-compliance
 * problem as D-035. A deterministic strip is reliable, costs nothing, and does
 * not burn a retry on a cosmetic issue. The prompt instruction stays, because it
 * reduces how often this has to fire. See D-048.
 */
const META_OPENERS =
  /\b(?:the (?:evidence|data) (?:shows?|suggests?|indicates?)|based on your results?|according to your (?:results?|data))\b[,:]?\s*(?:that\s+)?/gi;

export function polish(text: string): string {
  let out = text.replace(META_OPENERS, '');
  // Re-capitalise any sentence left starting lower-case by the strip.
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
  return out.replace(/\s{2,}/g, ' ').trim();
}

export async function generateRecommendationText(input: {
  trigger: RecommendationTrigger;
  projectName: string;
  goal?: string | null;
  userId: string;
  projectId: string;
}): Promise<{ text: RecommendationText; generated: boolean }> {
  const { trigger } = input;

  const system = [
    `You write one short, encouraging study recommendation. You are rephrasing a decision that has already been made — do not make a different suggestion.`,
    ``,
    `Rules:`,
    `- Address the learner as "you". Warm, plain, specific. No exclamation marks.`,
    `- Say what the evidence shows, then exactly one action: ${ACTION_PHRASING[trigger.action] ?? 'continue studying'}.`,
    `- Use the concept name if one is given. Do not invent facts beyond the evidence.`,
    `- Do not scold. A weak area is information, not a failing.`,
    // The evidence arrives as raw JSON, and without this the model parrots the
    // field names back: one live recommendation read "indicating a high error
    // rate and a blocked severity level", which is internal jargon leaking to
    // a learner. Say what it MEANS.
    `- Do not open with meta-commentary like "The evidence shows" or "Based on your results". Start with the learner and what is happening.`,
    `- Never repeat internal terms from the evidence: no "severity", "error rate", "trigger", "mastery score", "blocked", or field names. Translate them into plain language about their learning.`,
  ].join('\n');

  const facts = [
    `Project: ${input.projectName}`,
    input.goal ? `Their goal: ${input.goal.slice(0, 200)}` : '',
    `Reason: ${trigger.trigger}`,
    trigger.conceptName ? `Concept: ${trigger.conceptName}` : '',
    `Evidence: ${JSON.stringify(trigger.evidence)}`,
    `Required action: ${trigger.action}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { value } = await generateJson(
      generationProvider(),
      {
        feature: 'recommendation',
        // Fallback tier: short, high-volume, schema-bounded (CLAUDE.md).
        tier: 'fallback',
        reasoningEffort: 'low',
        system,
        messages: [{ role: 'user', content: facts }],
        maxTokens: 400,
        temperature: 0.5,
        userId: input.userId,
        projectId: input.projectId,
      },
      { schema: RecommendationTextSchema, schemaHint: RECOMMENDATION_SCHEMA_HINT },
    );
    return {
      text: { title: polish(value.title), body: polish(value.body) },
      generated: true,
    };
  } catch (err) {
    console.error('[recommendations] generation failed, using deterministic text:', (err as Error).message);
    return { text: fallbackText(trigger), generated: false };
  }
}

export { evaluateTriggers, type ProjectSnapshot, type RecommendationTrigger };
