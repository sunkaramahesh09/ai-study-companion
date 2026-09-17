import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProject, touchProject, type ProjectDashboard as Dash } from '../lib/queries.ts';
import { EmptyState, ErrorNote, MasteryBar, Spinner } from '../components/Ui.tsx';
import { MaterialUpload } from '../components/MaterialUpload.tsx';
import { Recommendations } from '../components/Recommendations.tsx';

const EVENT_LABELS: Record<string, string> = {
  project_created: 'Project created',
  material_uploaded: 'Material uploaded',
  material_ready: 'Material processed',
  material_failed: 'Processing failed',
  tutor_question: 'Asked the Tutor',
  tutor_unsupported: 'Tutor had insufficient evidence',
  quiz_started: 'Started a quiz',
  quiz_completed: 'Completed a quiz',
  mastery_updated: 'Mastery updated',
  recommendation_created: 'New recommendation',
};

const EVENT_ICONS: Record<string, string> = {
  project_created: '🆕',
  material_uploaded: '📄',
  material_ready: '✅',
  material_failed: '❌',
  tutor_question: '💬',
  tutor_unsupported: '⚠️',
  quiz_started: '▶️',
  quiz_completed: '🏆',
  mastery_updated: '📊',
  recommendation_created: '💡',
};

export function ProjectDashboard() {
  const { projectId } = useParams<{ projectId: string }>();
  const [dash, setDash] = useState<Dash | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!projectId) return;
    getProject(projectId).then(setDash).catch(setError);
    // Fire-and-forget: powers "Continue Learning" on the home dashboard.
    // A failure here must not affect the page the user is looking at.
    void touchProject(projectId).catch(() => {});
  }, [projectId]);

  if (error) return <ErrorNote error={error} />;
  if (!dash) return <Spinner />;

  const { project, materials, mastery, recommendations, recentActivity, conceptCount } = dash;
  const ready = materials.filter((m) => m.status === 'ready').length;

  return (
    <section className="fade-in">
      <Link to={`/spaces/${project.spaceId}`} className="back">← Back to Space</Link>

      {/* Project Hero */}
      <div className="project-hero">
        <div style={{ display: 'flex', gap: 'var(--space-4)', flex: 1 }}>
          <div className="project-hero-icon">📁</div>
          <div className="project-hero-info">
            <h2>{project.name}</h2>
            {project.goal && <p className="muted" style={{ marginTop: 'var(--space-1)' }}>🎯 Goal: {project.goal}</p>}
            <div className="project-hero-meta">
              <span>📄 {materials.length} materials</span>
              <span>✅ {ready} ready</span>
              <span>🧠 {conceptCount} concepts</span>
              <span>📅 {new Date(project.lastActiveAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="cta-row" style={{ marginTop: 'var(--space-4)' }}>
        <Link to={`/projects/${project.id}/tutor`} className="cta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          💬 Ask the Tutor
        </Link>
        <Link to={`/projects/${project.id}/quiz`} className="cta-ghost">
          ✅ Take a Quiz
        </Link>
        <Link to={`/projects/${project.id}/growth`} className="cta-ghost">
          📈 View Growth
        </Link>
        <Link to={`/projects/${project.id}/analytics`} className="cta-ghost">
          📊 Analytics
        </Link>
      </div>

      {/* Stats Cards */}
      <div className="stats stagger" style={{ marginTop: 'var(--space-4)' }}>
        <div className="stat">
          <span className="stat-n">{materials.length}</span>
          <span className="muted small">materials</span>
        </div>
        <div className="stat">
          <span className="stat-n">{ready}</span>
          <span className="muted small">ready</span>
        </div>
        <div className="stat">
          <span className="stat-n">{conceptCount}</span>
          <span className="muted small">concepts</span>
        </div>
      </div>

      <Recommendations projectId={project.id} initial={recommendations} />

      {/* Two Column: Materials + Mastery */}
      <div className="two-col" style={{ marginTop: 'var(--space-4)' }}>
        <MaterialUpload projectId={project.id} initial={materials} />

        <div className="card">
          <div className="card-head">
            <h3>Concept Mastery</h3>
            {mastery.length > 0 && (
              <Link to={`/projects/${project.id}/growth`} className="card-link">View growth →</Link>
            )}
          </div>
          {mastery.length === 0 ? (
            <EmptyState
              icon="🧠"
              title="No mastery data yet"
              hint="Take a quiz and estimates will appear here as evidence accumulates."
            />
          ) : (
            <ul className="list">
              {mastery.map((m) => (
                <li key={m.concept_id} className="mastery-row">
                  <span className="clamp">{m.concepts?.name ?? 'Concept'}</span>
                  <MasteryBar score={Number(m.score)} />
                  <span className="muted small">{Math.round(Number(m.score) * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h3>Recent Activity</h3>
        {recentActivity.length === 0 ? (
          <p className="muted">Nothing yet. Start using the project to see activity here.</p>
        ) : (
          <ul className="list" style={{ marginTop: 'var(--space-2)' }}>
            {recentActivity.map((a) => (
              <li key={a.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <span style={{ fontSize: 16 }}>{EVENT_ICONS[a.event_type] ?? '📌'}</span>
                  <span>{EVENT_LABELS[a.event_type] ?? a.event_type}</span>
                </div>
                <span className="muted small">{new Date(a.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
