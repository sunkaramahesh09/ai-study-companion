import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Project } from '@asc/shared';
import { createProject, listProjects } from '../lib/queries.ts';
import { EmptyState, ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';

export function SpaceDetail() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!spaceId) return;
    listProjects(spaceId).then(setProjects).catch(setError);
  }, [spaceId]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!spaceId) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({ spaceId, name, goal: goal || undefined });
      setProjects((prev) => [project, ...(prev ?? [])]);
      setName('');
      setGoal('');
      setCreating(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fade-in">
      <Link to="/spaces" className="back">← All Spaces</Link>

      <PageHeader
        icon="📋"
        title="Projects"
        description="A Project is one focused learning journey with its own materials and progress."
        action={
          <button onClick={() => setCreating((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {creating ? 'Cancel' : <><span>＋</span> New Project</>}
          </button>
        }
      />

      {creating && (
        <form className="card stack" onSubmit={onCreate} style={{ marginTop: 'var(--space-4)' }}>
          <h3>Create a New Project</h3>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Gradient Descent" />
          </label>
          <label>
            Learning goal <span className="muted">(recommended)</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Understand it well enough to explain it to someone else"
            />
            <span className="muted small">The Tutor uses this to tailor explanations and suggest what to do next.</span>
          </label>
          <div>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      )}

      {error ? <ErrorNote error={error} /> : null}
      {projects === null && !error && <Spinner />}

      {projects?.length === 0 && (
        <EmptyState
          icon="🎯"
          title="No Projects in this Space"
          hint="Create one, then upload material for the Tutor to learn from."
          action={<button onClick={() => setCreating(true)}>Create a Project</button>}
        />
      )}

      <div className="grid stagger" style={{ marginTop: 'var(--space-4)' }}>
        {projects?.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="card tile hover-lift">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <div style={{
                width: 44, height: 44, borderRadius: 'var(--radius-lg)',
                background: 'var(--primary-500)', color: 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 20, flexShrink: 0,
              }}>
                📁
              </div>
              <div style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                {p.goal && <p className="muted clamp" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>{p.goal}</p>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
              <span>📅 Last active {new Date(p.lastActiveAt).toLocaleDateString()}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
