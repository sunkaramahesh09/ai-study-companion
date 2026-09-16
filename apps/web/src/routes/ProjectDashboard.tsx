import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProject, touchProject, type ProjectDashboard as Dash } from '../lib/queries.ts';
import { EmptyState, ErrorNote, MasteryBar, Spinner } from '../components/Ui.tsx';
import { MaterialUpload } from '../components/MaterialUpload.tsx';

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
    <section>
      <Link to={`/spaces/${project.spaceId}`} className="back">← Back to Space</Link>

      <div className="section-head">
        <div>
          <h2>{project.name}</h2>
          {project.goal && <p className="muted">Goal: {project.goal}</p>}
        </div>
      </div>

      <div className="stats">
        <div className="stat"><span className="stat-n">{materials.length}</span><span className="muted small">materials</span></div>
        <div className="stat"><span className="stat-n">{ready}</span><span className="muted small">ready</span></div>
        <div className="stat"><span className="stat-n">{conceptCount}</span><span className="muted small">concepts</span></div>
      </div>

      {recommendations.length > 0 && (
        <div className="card accent">
          <h3>What to do next</h3>
          {recommendations.map((r) => (
            <div key={r.id}>
              <strong>{r.title}</strong>
              <p className="muted">{r.body}</p>
            </div>
          ))}
        </div>
      )}

      <div className="two-col">
        <MaterialUpload projectId={project.id} initial={materials} />

        <div className="card">
          <h3>Concept mastery</h3>
          {mastery.length === 0 ? (
            <EmptyState
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

      <div className="card">
        <h3>Recent activity</h3>
        {recentActivity.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="list">
            {recentActivity.map((a) => (
              <li key={a.id}>
                <span>{EVENT_LABELS[a.event_type] ?? a.event_type}</span>
                <span className="muted small">{new Date(a.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
