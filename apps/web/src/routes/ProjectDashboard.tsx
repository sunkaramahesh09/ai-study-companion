import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProject, touchProject, type ProjectDashboard as Dash } from '../lib/queries.ts';
import { EmptyState, ErrorNote, MasteryBar, Spinner } from '../components/Ui.tsx';
import { MaterialUpload } from '../components/MaterialUpload.tsx';
import { Recommendations } from '../components/Recommendations.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';

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

const EVENT_ICONS: Record<string, IconName> = {
  project_created: 'sparkle',
  material_uploaded: 'file',
  material_ready: 'check-circle',
  material_failed: 'x-circle',
  tutor_question: 'tutor',
  tutor_unsupported: 'alert',
  quiz_started: 'play',
  quiz_completed: 'trophy',
  mastery_updated: 'chart-bar',
  recommendation_created: 'bulb',
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
          <div className="project-hero-icon"><Icon name="folder" size={16} /></div>
          <div className="project-hero-info">
            <h2>{project.name}</h2>
            {project.goal && <p className="muted" style={{ marginTop: 'var(--space-1)' }}><Icon name="target" size={15} /> Goal: {project.goal}</p>}
            <div className="project-hero-meta">
              <span><Icon name="file" size={14} /> {materials.length} materials</span>
              <span><Icon name="check-circle" size={14} /> {ready} ready</span>
              <span><Icon name="brain" size={14} /> {conceptCount} concepts</span>
              <span><Icon name="calendar" size={14} /> {new Date(project.lastActiveAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="cta-row" style={{ marginTop: 'var(--space-4)' }}>
        <Link to={`/projects/${project.id}/tutor`} className="cta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Icon name="tutor" size={15} /> Ask the Tutor
        </Link>
        <Link to={`/projects/${project.id}/quiz`} className="cta-ghost">
          <Icon name="check-circle" size={15} /> Take a Quiz
        </Link>
        <Link to={`/projects/${project.id}/flashcards`} className="cta-ghost">
          <Icon name="cards" size={15} /> Flashcards
        </Link>
        <Link to={`/projects/${project.id}/growth`} className="cta-ghost">
          <Icon name="trend-up" size={15} /> View Growth
        </Link>
        <Link to={`/projects/${project.id}/analytics`} className="cta-ghost">
          <Icon name="chart-bar" size={15} /> Analytics
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
              icon={<Icon name="brain" size={26} />}
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
                  <Icon name={EVENT_ICONS[a.event_type] ?? 'info'} size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
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
