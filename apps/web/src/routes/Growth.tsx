import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getGrowth, type ConceptGrowth, type GrowthResponse } from '../lib/queries.ts';
import { EmptyState, ErrorNote, MasteryBar, Spinner, ProgressRing, PageHeader } from '../components/Ui.tsx';

const TREND_LABEL: Record<ConceptGrowth['growth']['trend'], string> = {
  improving: '📈 Improving',
  stable: '➡️ Stable',
  needs_attention: '⚠️ Needs attention',
  new: '🆕 Not assessed',
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
      <path d={d} fill="none" stroke={rising ? 'var(--ok)' : 'var(--error)'} strokeWidth="2" strokeLinecap="round" />
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
  // null means no concept has been assessed yet — distinct from a real 0%,
  // which would read as "you're failing" rather than "not tested yet".
  const avgMastery = summary.averageMastery;

  return (
    <section className="fade-in">
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>

      <PageHeader
        icon="📊"
        title="Progress & Growth"
        description="How your understanding is changing. Mastery is an estimate from your answers, not a grade."
        action={<Link to={`/projects/${projectId}/quiz`} className="cta">✅ Take a quiz</Link>}
      />

      {/* Mastery Overview */}
      <div className="card" style={{ marginTop: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {avgMastery !== null ? (
              <ProgressRing
                value={avgMastery}
                size={140}
                label="Overall Mastery"
                color={avgMastery >= 0.7 ? 'var(--ok)' : avgMastery >= 0.4 ? 'var(--warning-500)' : 'var(--error)'}
              />
            ) : (
              <div style={{
                width: 140, height: 140, borderRadius: '50%',
                border: '2px dashed var(--border-normal)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexDirection: 'column', textAlign: 'center', padding: 'var(--space-3)',
              }}>
                <span className="muted small">No assessed concepts yet</span>
              </div>
            )}
          </div>
          <div className="stats" style={{ flex: 1 }}>
            <div className="stat">
              <span className="stat-n ok">{summary.improving}</span>
              <span className="muted small">📈 Improving</span>
            </div>
            <div className="stat">
              <span className="stat-n">{summary.stable}</span>
              <span className="muted small">➡️ Stable</span>
            </div>
            <div className="stat">
              <span className="stat-n error">{summary.needsAttention}</span>
              <span className="muted small">⚠️ Need attention</span>
            </div>
            <div className="stat">
              <span className="stat-n">{summary.assessed}/{summary.total}</span>
              <span className="muted small">🧠 Assessed</span>
            </div>
          </div>
        </div>
        {avgMastery !== null && avgMastery > 0.6 && (
          <div style={{
            marginTop: 'var(--space-4)',
            padding: 'var(--space-3)',
            background: 'var(--success-50)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--success-700)',
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
          }}>
            🎉 Great progress! You're above {Math.round(avgMastery * 100)}% mastery across assessed concepts.
          </div>
        )}
      </div>

      {/* Concept List */}
      {concepts.length === 0 ? (
        <EmptyState
          icon="🧠"
          title="No concepts yet"
          hint="Upload material and let it process — concepts are extracted from it automatically."
        />
      ) : (
        <div className="card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-head">
            <h3>Concept Mastery</h3>
            <span className="muted small">
              {summary.assessed} of {summary.total} concepts assessed
            </span>
          </div>
          <ul className="growth-list">
            {concepts.map((c) => (
              <li key={c.conceptId} className="growth-row">
                <div className="growth-main">
                  <div className="growth-head">
                    <strong className="clamp">{c.name}</strong>
                    <span className={`pill trend-${c.growth.trend}`}>{TREND_LABEL[c.growth.trend]}</span>
                  </div>
                  <p className="muted small" style={{ marginTop: 'var(--space-1)' }}>{c.growth.summary}</p>
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

      {/* Motivational Quote */}
      <div className="quote-card" style={{ marginTop: 'var(--space-4)' }}>
        <blockquote>"Success is the sum of small efforts, repeated day in and day out."</blockquote>
        <cite>— Robert Collier</cite>
      </div>
    </section>
  );
}
