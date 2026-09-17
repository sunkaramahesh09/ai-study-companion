import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getGrowth, type ConceptGrowth, type GrowthResponse } from '../lib/queries.ts';
import { EmptyState, ErrorNote, MasteryBar, Spinner } from '../components/Ui.tsx';

const TREND_LABEL: Record<ConceptGrowth['growth']['trend'], string> = {
  improving: 'Improving',
  stable: 'Stable',
  needs_attention: 'Needs attention',
  new: 'Not assessed',
};

/** A tiny inline chart. A trend is easier to see than to read. */
function Sparkline({ points }: { points: { score: number }[] }) {
  if (points.length < 2) return null;
  const w = 64;
  const h = 18;
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - p.score * h).toFixed(1)}`)
    .join(' ');
  const rising = points[points.length - 1]!.score >= points[0]!.score;
  return (
    <svg width={w} height={h} className="spark" aria-hidden="true">
      <path d={d} fill="none" stroke={rising ? 'var(--ok)' : 'var(--error)'} strokeWidth="1.5" />
    </svg>
  );
}

export function Growth() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!projectId) return;
    getGrowth(projectId).then(setData).catch(setError);
  }, [projectId]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  const { summary, concepts } = data;

  return (
    <section>
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>
      <div className="section-head">
        <div>
          <h2>Growth</h2>
          <p className="muted">
            How your understanding is changing. Mastery is an estimate from your answers, not a grade.
          </p>
        </div>
        <Link to={`/projects/${projectId}/quiz`} className="cta">Take a quiz</Link>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-n">
            {summary.averageMastery === null ? '—' : `${Math.round(summary.averageMastery * 100)}%`}
          </span>
          <span className="muted small">average mastery</span>
        </div>
        <div className="stat"><span className="stat-n ok">{summary.improving}</span><span className="muted small">improving</span></div>
        <div className="stat"><span className="stat-n">{summary.stable}</span><span className="muted small">stable</span></div>
        <div className="stat"><span className="stat-n error">{summary.needsAttention}</span><span className="muted small">need attention</span></div>
      </div>

      {concepts.length === 0 ? (
        <EmptyState
          title="No concepts yet"
          hint="Upload material and let it process — concepts are extracted from it automatically."
        />
      ) : (
        <div className="card">
          <p className="muted small">
            {summary.assessed} of {summary.total} concepts have been assessed. Untested concepts show no
            estimate rather than a guess.
          </p>
          <ul className="growth-list">
            {concepts.map((c) => (
              <li key={c.conceptId} className="growth-row">
                <div className="growth-main">
                  <div className="growth-head">
                    <strong className="clamp">{c.name}</strong>
                    <span className={`pill trend-${c.growth.trend}`}>{TREND_LABEL[c.growth.trend]}</span>
                  </div>
                  <p className="muted small">{c.growth.summary}</p>
                </div>
                <div className="growth-meter">
                  <Sparkline points={c.history} />
                  <MasteryBar score={c.score} />
                  <span className="muted small growth-pct">
                    {c.evidenceCount === 0 ? '—' : `${Math.round(c.score * 100)}%`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
