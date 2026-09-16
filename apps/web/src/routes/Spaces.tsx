import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createSpace, listSpaces } from '../lib/queries.ts';
import type { Space } from '@asc/shared';
import { EmptyState, ErrorNote, Spinner } from '../components/Ui.tsx';

export function Spaces() {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listSpaces().then(setSpaces).catch(setError);
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const space = await createSpace({ name, description: description || undefined });
      setSpaces((prev) => [space, ...(prev ?? [])]);
      setName('');
      setDescription('');
      setCreating(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Spaces</h2>
          <p className="muted">A Space is a broad area you want to learn. Projects live inside it.</p>
        </div>
        <button onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : 'New Space'}</button>
      </div>

      {creating && (
        <form className="card stack" onSubmit={onCreate}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Machine Learning" />
          </label>
          <label>
            Description <span className="muted">(optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} />
          </label>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create Space'}
          </button>
        </form>
      )}

      {error ? <ErrorNote error={error} /> : null}
      {spaces === null && !error && <Spinner />}

      {spaces?.length === 0 && (
        <EmptyState
          title="No Spaces yet"
          hint="Start with a broad area — a subject, a certification, a skill you want to build."
          action={<button onClick={() => setCreating(true)}>Create your first Space</button>}
        />
      )}

      <div className="grid">
        {spaces?.map((s) => (
          <Link key={s.id} to={`/spaces/${s.id}`} className="card tile">
            <strong>{s.name}</strong>
            {s.description && <p className="muted clamp">{s.description}</p>}
            <span className="muted small">
              {s.projectCount ?? 0} {s.projectCount === 1 ? 'project' : 'projects'}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
