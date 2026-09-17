import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listSpaces, getGlobalAnalytics, type GlobalAnalytics } from '../lib/queries.ts';
import { Spinner, StatCard, ProgressRing } from '../components/Ui.tsx';
import type { Space } from '@asc/shared';

export function Home() {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [analytics, setAnalytics] = useState<GlobalAnalytics | null>(null);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  useEffect(() => {
    listSpaces().then(setSpaces).catch(() => {});
    getGlobalAnalytics(30).then(setAnalytics).catch(() => {});
  }, []);

  if (!spaces) return <Spinner label="Loading your dashboard..." />;

  const quotes = [
    { text: 'Learning is not a spectator sport.', author: 'D. Blocher' },
    { text: 'The expert in anything was once a beginner.', author: 'Helen Hayes' },
    { text: 'Discipline turns information into knowledge.', author: 'Jim Rohn' },
  ];
  const quote = quotes[Math.floor(Date.now() / 86400000) % quotes.length]!;

  // Recent accuracy over the last 30 days, distinct from the deterministic
  // mastery score (D-038) — this endpoint is global and does not compute
  // mastery, which only exists per concept per project. `null` means no
  // assessed questions yet, not zero.
  const accuracy = analytics?.assessment.recentAccuracy ?? analytics?.assessment.accuracy ?? null;
  const quizzesCompleted = analytics?.activity.byType['quiz_completed'] ?? 0;

  return (
    <section className="fade-in home-page">
      {/* Decorative only — fixed, behind everything, aria-hidden. Adds depth
          to the page without competing with the white card surfaces. */}
      <div className="home-page-decor" aria-hidden="true" />

      <div className="content-with-sidebar">
        <div className="stack" style={{ gap: 'var(--space-6)' }}>
          {/* Welcome Hero */}
          <div className="home-hero">
            <div className="home-hero-decor" aria-hidden="true">
              <span className="login-blob login-blob-1" />
              <span className="login-blob login-blob-2" />
              <span className="home-hero-sparkle home-hero-sparkle-1">✦</span>
              <span className="home-hero-sparkle home-hero-sparkle-2">✦</span>
            </div>

            <div className="home-hero-body">
              <div>
                <p style={{ fontSize: 'var(--text-lg)', opacity: 0.9, marginBottom: 'var(--space-1)' }}>👋 {greeting},</p>
                <h2>Let's keep learning!</h2>
                <p style={{ marginTop: 'var(--space-2)' }}>
                  Your AI-powered study companion is here to help you understand, practice and excel.
                </p>
              </div>

              <div className="home-hero-illustration">
                <span className="home-hero-illustration-glow" aria-hidden="true" />
                <img
                  src="/ai-brain.jpg"
                  alt="AI Study Companion"
                  style={{
                    width: 96,
                    height: 96,
                    objectFit: 'cover',
                    borderRadius: '50%',
                    boxShadow: '0 16px 32px rgba(108, 71, 236, 0.2)',
                    border: '3px solid white',
                    mixBlendMode: 'multiply',
                    position: 'relative',
                  }}
                />
                <div className="home-hero-callout" aria-hidden="true">
                  💡 Small steps every day lead to big results!
                </div>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="home-stats stagger">
            <StatCard
              icon="🗂️"
              iconBg="var(--lavender-100)"
              value={analytics?.totals.spaces ?? '—'}
              label="Study Spaces"
            />
            <StatCard
              icon="💬"
              iconBg="var(--info-50)"
              value={analytics?.assessment.answered ?? '—'}
              label="Questions Answered"
            />
            <StatCard
              icon="✅"
              iconBg="var(--success-50)"
              value={quizzesCompleted}
              label="Quizzes Completed"
            />
            <StatCard
              icon="📊"
              iconBg="var(--warning-50)"
              value={accuracy !== null ? `${Math.round(accuracy * 100)}%` : '—'}
              label="Recent Accuracy"
            />
          </div>

          {/* Ask Tutor Section */}
          <div className="card">
            <div className="card-head" style={{ marginBottom: 'var(--space-4)' }}>
              <div>
                <h3 style={{ fontSize: 'var(--text-lg)', margin: 0 }}>Ask Your AI Tutor</h3>
                <p className="muted" style={{ marginTop: 'var(--space-1)', fontSize: 'var(--text-sm)' }}>
                  Get explanations, clarify doubts, or dive deeper into any topic from your materials.
                </p>
              </div>
            </div>

            <div className="quick-actions" style={{ marginBottom: 'var(--space-4)' }}>
              <Link to="/spaces" className="quick-action">💡 Explain a concept in simple terms</Link>
              <Link to="/spaces" className="quick-action">📝 Get an example from your notes</Link>
              <Link to="/spaces" className="quick-action">⚠️ Find common mistakes on a topic</Link>
              <Link to="/spaces" className="quick-action">🔗 See how topics connect</Link>
            </div>

            <div className="ask">
              <div className="ask-input-row">
                <input
                  placeholder="Pick a project to ask its Tutor…"
                  onClick={() => window.location.href = '/spaces'}
                  readOnly
                  style={{ cursor: 'pointer' }}
                />
                <Link to="/spaces" className="cta ask-send">
                  Go →
                </Link>
              </div>
            </div>
          </div>

          {/* Recent Materials & Learning Progress */}
          <div className="two-col">
            <div className="card">
              <div className="card-head">
                <h3>Your Spaces</h3>
                <Link to="/spaces" className="card-link">View all →</Link>
              </div>
              {spaces.length > 0 ? (
                <div className="stack" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                  <p className="muted small">Open a space to upload materials and start learning with AI.</p>
                  <Link to={`/spaces/${spaces[0]?.id}`} className="cta small-cta" style={{ alignSelf: 'flex-start' }}>
                    Go to your first space →
                  </Link>
                </div>
              ) : (
                <div className="empty">
                  <p className="muted">No spaces yet. Create one and upload your first PDF.</p>
                  <Link to="/spaces" className="cta small-cta" style={{ marginTop: 'var(--space-2)' }}>Create a Space</Link>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Recent Accuracy</h3>
                <span className="muted small">Last 30 days</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
                {accuracy !== null ? (
                  <ProgressRing value={accuracy} size={140} label="Recent Accuracy" />
                ) : (
                  <p className="muted small">Take a quiz to see your accuracy here.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="content-sidebar">
          {/* Quote Card — the gradient, glow and mountain silhouette are one
              layered background composition, not an image placed on a card. */}
          <div className="quote-card">
            <div className="quote-card-mountains" aria-hidden="true">
              <span />
              <span />
            </div>
            <blockquote>"{quote.text}"</blockquote>
            <cite>— {quote.author}</cite>
          </div>

          {/* Study Streak */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <span style={{ fontSize: 22 }}>🔥</span>
              <div>
                <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>{analytics?.activity.streak.current ?? 0}</div>
                <div className="muted small">days in a row</div>
              </div>
            </div>
          </div>

          {/* Recommendations pointer */}
          <div className="card">
            <div className="card-head">
              <h3>Recommendations</h3>
            </div>
            <div className="stack" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
              <p className="muted small">
                Recommendations are generated per project, based on your quiz results and mistakes there.
                Open a project's dashboard to see yours.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
