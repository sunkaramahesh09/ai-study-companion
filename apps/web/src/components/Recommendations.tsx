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

const ACTIONS: Record<string, { label: string; path: (projectId: string) => string }> = {
  take_quiz: { label: 'Take a quiz', path: (p) => `/projects/${p}/quiz` },
  ask_tutor: { label: 'Ask the Tutor', path: (p) => `/projects/${p}/tutor` },
  review_material: { label: 'Review material', path: (p) => `/projects/${p}` },
  upload_material: { label: 'Upload material', path: (p) => `/projects/${p}` },
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
    <div className="card accent">
      <h3>What to do next</h3>
      {error && <p className="error small">{error}</p>}
      <ul className="list rec-list">
        {items.map((r) => {
          const action = ACTIONS[r.action_type] ?? ACTIONS['review_material']!;
          return (
            <li key={r.id} className="rec">
              <div className="rec-body">
                <strong>{r.title}</strong>
                <p className="muted">{r.body}</p>
              </div>
              <div className="rec-actions">
                <Link
                  to={action.path(projectId)}
                  className="cta small-cta"
                  onClick={() => void resolve(r.id, 'completed')}
                >
                  {action.label}
                </Link>
                <button
                  type="button"
                  className="linkish"
                  disabled={busy === r.id}
                  onClick={() => void resolve(r.id, 'dismissed')}
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
