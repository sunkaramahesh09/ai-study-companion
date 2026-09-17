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
                  to={action.path(projectId)}
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
