import { useState } from 'react';
import { Link } from 'react-router-dom';
import { resolveRecommendation, type RecommendationRow } from '../lib/queries.ts';

/**
 * "What to do next" on the project dashboard (PRD §12).
 *
 * The recommendation is chosen by deterministic trigger rules in the worker;
 * only the sentence was generated. Each one therefore has a concrete action it
 * maps to, and the card links straight to it — a suggestion the learner has to
 * go and find is a suggestion they will not take.
 */

/**
 * Turns a recommendation title into a question for the Tutor.
 *
 * Titles are generated in the shape "Review <Concept>" / "Practise <Concept>",
 * so stripping the leading verb recovers the concept without needing the id
 * plumbed through the dashboard payload. If the shape is ever different the
 * whole title is used, which still asks something sensible.
 */
function conceptQuestion(title: string): string {
  const concept = title.replace(/^(review|revise|practise|practice|study|revisit)\s+/i, '').trim();
  return `Explain ${concept || title} using my materials, and show me where it comes from.`;
}

const ACTIONS: Record<
  string,
  { label: string; path: (projectId: string, rec: RecommendationRow) => string }
> = {
  take_quiz: { label: 'Take a quiz', path: (p) => `/projects/${p}/quiz` },
  ask_tutor: { label: 'Ask the Tutor', path: (p) => `/projects/${p}/tutor` },
  // Was `/projects/${p}` — the dashboard the card is already displayed on, so
  // the button dismissed the card and appeared to do nothing. "Review this
  // concept" means reading the material about it, and the Tutor is how this
  // product reads material: grounded in the learner's own PDFs with citations
  // back to the page. The question arrives prefilled, not auto-sent, so the
  // learner stays in control and no quota is spent just by navigating.
  review_material: {
    label: 'Review this concept',
    path: (p, rec) => `/projects/${p}/tutor?q=${encodeURIComponent(conceptQuestion(rec.title))}`,
  },
  upload_material: { label: 'Upload material', path: (p) => `/projects/${p}#materials` },
};

export function Recommendations({
  projectId,
  initial,
}: {
  projectId: string;
  initial: RecommendationRow[];
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function resolve(id: string, status: 'dismissed' | 'completed') {
    setBusy(id);
    setError(null);
    // Optimistic: the card disappears immediately, and is restored if the
    // request fails. A recommendation that lingers after "dismiss" reads as a
    // broken button.
    const before = items;
    setItems((cur) => cur.filter((r) => r.id !== id));
    try {
      await resolveRecommendation(id, status);
    } catch (err) {
      setItems(before);
      setError(err instanceof Error ? err.message : 'Could not update that.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <h3 style={{ marginBottom: 'var(--space-3)' }}>What to do next</h3>
      {error && <p className="error small" style={{ marginBottom: 'var(--space-2)' }}>{error}</p>}
      <div className="grid">
        {items.map((r) => {
          const action = ACTIONS[r.action_type] ?? ACTIONS['review_material']!;
          return (
            <div key={r.id} className="topic-rec-card fade-in">
              <span className="topic-rec-priority priority-medium">⚡ Recommended</span>
              <strong style={{ display: 'block', fontSize: 'var(--text-md)', marginBottom: 'var(--space-2)' }}>
                {r.title}
              </strong>
              <p className="muted small clamp" style={{ marginBottom: 'var(--space-3)' }}>
                {r.body}
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Link
                  to={action.path(projectId, r)}
                  className="btn-secondary"
                  style={{ padding: '6px 12px', fontSize: 'var(--text-sm)' }}
                  onClick={() => void resolve(r.id, 'completed')}
                >
                  {action.label}
                </Link>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '6px 12px', fontSize: 'var(--text-sm)' }}
                  disabled={busy === r.id}
                  onClick={() => void resolve(r.id, 'dismissed')}
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
