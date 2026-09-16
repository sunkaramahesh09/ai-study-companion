import type { ReactNode } from 'react';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted">{label}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <p className="error">{message}</p>;
}

/**
 * Empty states carry the next action rather than just saying "nothing here".
 * The PRD's home dashboard has to answer "what should I do next?" (§16), and an
 * empty project is exactly when that question is most acute.
 */
export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p className="muted">{hint}</p>
      {action}
    </div>
  );
}

export function MasteryBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  // Mastery is an estimate, not a measurement (PRD §10) — the tone stays
  // informative rather than a pass/fail judgement.
  const tone = pct >= 75 ? 'ok' : pct >= 50 ? 'warn' : 'low';
  return (
    <div className="bar" role="img" aria-label={`${pct}% mastery`}>
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}
