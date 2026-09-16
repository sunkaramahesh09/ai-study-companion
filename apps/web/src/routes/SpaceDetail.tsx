import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Project } from '@asc/shared';
import { createProject, listProjects } from '../lib/queries.ts';
import { EmptyState, ErrorNote, Spinner } from '../components/Ui.tsx';

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
    <section>
      <Link to="/" className="back">← All Spaces</Link>
      <div className="section-head">
        <div>
          <h2>Projects</h2>
          <p className="muted">A Project is one focused learning journey with its own materials and progress.</p>
        </div>
        <button onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : 'New Project'}</button>
      </div>

      {creating && (
        <form className="card stack" onSubmit={onCreate}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Gradient Descent" />
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
            {/* The goal is optional in the schema but genuinely shapes output:
                it feeds Tutor context and recommendation generation. */}
            <span className="muted small">The Tutor uses this to tailor explanations and suggest what to do next.</span>
          </label>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create Project'}
          </button>
        </form>
      )}

      {error ? <ErrorNote error={error} /> : null}
      {projects === null && !error && <Spinner />}

      {projects?.length === 0 && (
        <EmptyState
          title="No Projects in this Space"
          hint="Create one, then upload material for the Tutor to learn from."
          action={<button onClick={() => setCreating(true)}>Create a Project</button>}
        />
      )}

      <div className="grid">
        {projects?.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="card tile">
            <strong>{p.name}</strong>
            {p.goal && <p className="muted clamp">{p.goal}</p>}
            <span className="muted small">
              Last active {new Date(p.lastActiveAt).toLocaleDateString()}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
