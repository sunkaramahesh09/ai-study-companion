import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createSpace, listSpaces } from '../lib/queries.ts';
import type { Space } from '@asc/shared';
import { EmptyState, ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';

const SPACE_ICONS: IconName[] = ['book', 'brain', 'file', 'link', 'flask', 'cap', 'target', 'folder'];
const SPACE_COLORS = [
  { bg: 'var(--lavender-100)', color: 'var(--primary-500)' },
  { bg: 'var(--success-50)', color: 'var(--success-600)' },
  { bg: 'var(--warning-50)', color: 'var(--warning-600)' },
  { bg: 'var(--error-50)', color: 'var(--error-500)' },
  { bg: 'var(--info-50)', color: 'var(--info-500)' },
  { bg: '#fce7f3', color: '#db2777' },
];

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
    <section className="fade-in">
      <PageHeader
        icon={<Icon name="upload" size={26} />}
        title="Spaces"
        description="A Space is a broad area you want to learn. Projects live inside it."
        action={
          <button onClick={() => setCreating((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {creating ? 'Cancel' : <><span>＋</span> New Space</>}
          </button>
        }
      />

      {/* Hero */}
      <div className="spaces-hero">
        <div className="overline">ORGANIZE YOUR LEARNING</div>
        <h2>Turn your goals into spaces.</h2>
        <p>
          Create spaces for each subject or interest, add projects, upload materials,
          and get personalized learning support from AI.
        </p>
        {(!spaces || spaces.length === 0) && (
          <button onClick={() => setCreating(true)} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            ＋ Create Your First Space
          </button>
        )}
      </div>

      {/* Create Form */}
      {creating && (
        <form className="card stack" onSubmit={onCreate} style={{ marginTop: 'var(--space-4)' }}>
          <h3>Create a New Space</h3>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Machine Learning" />
          </label>
          <label>
            Description <span className="muted">(optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} placeholder="What is this space about?" />
          </label>
          <div>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create Space'}
            </button>
          </div>
        </form>
      )}

      {error ? <ErrorNote error={error} /> : null}
      {spaces === null && !error && <Spinner />}

      {spaces?.length === 0 && !creating && (
        <EmptyState
          icon={<Icon name="book" size={26} />}
          title="No Spaces yet"
          hint="Start with a broad area — a subject, a certification, a skill you want to build."
          action={<button onClick={() => setCreating(true)}>Create your first Space</button>}
        />
      )}

      {/* Spaces Grid */}
      {spaces && spaces.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 'var(--space-5) 0 var(--space-3)' }}>
            <h3>Your Spaces</h3>
          </div>
          <div className="grid stagger">
            {/* Create new space card */}
            <div
              className="card create-space-card"
              onClick={() => setCreating(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setCreating(true)}
            >
              <span style={{ fontSize: 32, color: 'var(--primary-400)' }}>＋</span>
              <strong style={{ color: 'var(--primary-500)' }}>Create a New Space</strong>
              <p className="muted small">Organize your learning by subject, course, or interest.</p>
            </div>

            {/* Space cards */}
            {spaces.map((s, i) => {
              const colorScheme = SPACE_COLORS[i % SPACE_COLORS.length]!;
              const icon = SPACE_ICONS[i % SPACE_ICONS.length];
              return (
                <Link key={s.id} to={`/spaces/${s.id}`} className="card tile space-card hover-lift">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div className="space-card-icon" style={{ background: colorScheme.bg, color: colorScheme.color }}>
                      {icon}
                    </div>
                  </div>
                  <strong style={{ fontSize: 'var(--text-md)' }}>{s.name}</strong>
                  {s.description && <p className="muted clamp" style={{ fontSize: 'var(--text-sm)' }}>{s.description}</p>}
                  <div className="space-card-meta">
                    <span><Icon name="clipboard" size={14} /> {s.projectCount ?? 0} Projects</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
