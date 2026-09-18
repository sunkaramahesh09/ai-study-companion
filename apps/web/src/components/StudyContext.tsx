import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project, Space } from '@asc/shared';
import { useStudyContext, type StudyContextState } from '../lib/studyContext.ts';
import { EmptyState, ErrorNote, Spinner } from './Ui.tsx';
import { Icon, type IconName } from './Icon.tsx';

/**
 * Tutor and Quiz belong to a project, but a learner arriving from the sidebar
 * has one in mind already — almost always the one they were just in. Making
 * them walk Spaces → Space → Project → Quiz every time is three clicks to
 * re-state something the app already knows.
 *
 * So both places lead with the last used space and project, and keep the
 * switcher one click away rather than making it the only path. See D-065.
 */

type Mode = 'quiz' | 'tutor';

const MODE_LABEL: Record<Mode, string> = { quiz: 'Quiz', tutor: 'Tutor' };

/** Space and project selects, wired so a space change cannot leave a project from the previous one selected. */
function ProjectSwitcher({
  spaces,
  projects,
  projectId,
  submitLabel,
  onPick,
}: {
  spaces: Space[];
  projects: Project[];
  projectId?: string;
  submitLabel: string;
  onPick: (project: Project) => void;
}) {
  const current = projects.find((p) => p.id === projectId);
  const [spaceId, setSpaceId] = useState(current?.spaceId ?? projects[0]?.spaceId ?? spaces[0]?.id ?? '');
  const [pickedId, setPickedId] = useState(current?.id ?? projects[0]?.id ?? '');

  // Selecting a different space must move the project select with it, or the
  // form would read "Space A / a project from Space B" and submit that.
  useEffect(() => {
    const ids = projects.filter((p) => p.spaceId === spaceId).map((p) => p.id);
    setPickedId((cur) => (ids.includes(cur) ? cur : (ids[0] ?? '')));
  }, [spaceId, projects]);

  const inSpace = projects.filter((p) => p.spaceId === spaceId);
  const picked = projects.find((p) => p.id === pickedId) ?? null;

  return (
    <div className="context-switcher">
      <label>
        Space
        <select className="select" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Project
        <select
          className="select"
          value={pickedId}
          onChange={(e) => setPickedId(e.target.value)}
          disabled={inSpace.length === 0}
        >
          {inSpace.length === 0 ? (
            <option value="">No projects in this space</option>
          ) : (
            inSpace.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))
          )}
        </select>
      </label>

      <div className="context-switcher-actions">
        {/* No Cancel here: the control that opened this row is the one that
            closes it, and two of them side by side just looks like a bug. */}
        <button type="button" disabled={!picked} onClick={() => picked && onPick(picked)}>
          {submitLabel}
        </button>
      </div>

      {inSpace.length === 0 && spaceId && (
        <p className="muted small" style={{ gridColumn: '1 / -1' }}>
          That space has no projects yet.{' '}
          <Link to={`/spaces/${spaceId}`}>Create one →</Link>
        </p>
      )}
    </div>
  );
}

/**
 * Compact breadcrumb for a page already scoped to a project: says which space
 * and project you are in, and lets you move to another without leaving.
 */
export function StudyContextBar({ projectId, mode }: { projectId: string; mode: Mode }) {
  const navigate = useNavigate();
  const { spaces, projects, current, loading } = useStudyContext(projectId);
  const [open, setOpen] = useState(false);

  // The shell renders from the first frame, names or not. Returning null while
  // the names load and the bar in afterwards would push the whole page down a
  // beat after it settled — the jump is worse than a moment of grey.
  return (
    <div className="context-bar">
      <div className="context-bar-crumbs">
        <Link to={`/projects/${projectId}`} className="context-bar-back" title="Back to project">
          <Icon name="arrow-right" size={16} />
        </Link>
        {current ? (
          <>
            <span className="context-bar-space">
              <Icon name="folder" size={14} />
              {current.space?.name ?? 'Space'}
            </span>
            <span className="context-bar-sep">›</span>
            <Link to={`/projects/${projectId}`} className="context-bar-project">
              {current.project.name}
            </Link>
          </>
        ) : (
          <span className="skeleton context-bar-loading" aria-hidden="true" />
        )}
      </div>

      <button
        type="button"
        className="context-bar-change"
        disabled={!current}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="refresh" size={14} /> {open ? 'Close' : 'Change'}
      </button>

      {open && !loading && (
        <ProjectSwitcher
          spaces={spaces}
          projects={projects}
          projectId={projectId}
          submitLabel={`Open ${MODE_LABEL[mode]}`}
          onPick={(p) => {
            setOpen(false);
            navigate(`/projects/${p.id}/${mode}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * "Pick up where you left off" — the landing card for Spaces and for the
 * sidebar's Tutor/Quiz entries. One click continues; the switcher is there for
 * the times the answer is a different project.
 */
type ContinueCardProps = {
  /** What continuing means here. Omitted (Spaces) it means "open the project". */
  defaultMode?: Mode;
  /** Chips for the next few projects — faster than the switcher when the answer is "the other one". */
  showRecents?: boolean;
  /** For pages that already say something sensible when there is nothing to continue. */
  hideWhenEmpty?: boolean;
};

/** Self-fetching form, for a page whose only content is this card. */
export function ContinueCard(props: ContinueCardProps) {
  const ctx = useStudyContext();
  return <ContinueCardView ctx={ctx} {...props} />;
}

/**
 * Same card, driven by data the page already has.
 *
 * A page that renders its own content *and* this card must load both through
 * one gate. Letting the card fetch separately means it arrives after the page
 * has painted and pushes everything below it down — which is exactly what
 * Spaces did.
 */
export function ContinueCardView({
  ctx,
  defaultMode,
  showRecents = false,
  hideWhenEmpty = false,
}: ContinueCardProps & { ctx: StudyContextState }) {
  const navigate = useNavigate();
  const { spaces, projects, current, loading, error } = ctx;
  const [open, setOpen] = useState(false);

  // When the card is an addition to a page that stands on its own, it stays out
  // of the way entirely until it has something to offer — no spinner above the
  // content it is meant to shortcut, no second error for the same failure.
  if (hideWhenEmpty && (loading || error || !current)) return null;

  if (loading) return <Spinner label="Finding where you left off…" />;
  if (error) return <ErrorNote error={error} />;

  if (!current) {
    return (
      <EmptyState
        icon={<Icon name="target" size={26} />}
        title={spaces.length === 0 ? 'No Spaces yet' : 'No Projects yet'}
        hint={
          spaces.length === 0
            ? 'A Space holds your projects. Create one, add a project, upload material — then the Tutor and quizzes have something to work from.'
            : 'Open a Space and create a project. Quizzes and the Tutor run inside a project.'
        }
        action={
          <Link to="/spaces" className="cta">
            Go to Spaces
          </Link>
        }
      />
    );
  }

  const { project, space } = current;
  // Where "continue" lands: the page's own feature when it has one, the project
  // dashboard on Spaces, where no single feature is the obvious next step.
  const dest = (id: string) => (defaultMode ? `/projects/${id}/${defaultMode}` : `/projects/${id}`);
  // Whatever continuing does not already cover, offered alongside it.
  const secondary: { to: string; icon: IconName; label: string }[] = [
    ...(defaultMode !== 'tutor'
      ? [{ to: `/projects/${project.id}/tutor`, icon: 'tutor' as IconName, label: 'Ask the Tutor' }]
      : []),
    ...(defaultMode !== 'quiz'
      ? [{ to: `/projects/${project.id}/quiz`, icon: 'quiz' as IconName, label: 'Take a quiz' }]
      : []),
    ...(defaultMode
      ? [{ to: `/projects/${project.id}`, icon: 'folder' as IconName, label: 'Open project' }]
      : []),
  ];
  // Already ordered by last activity, so these are the next-most-likely answers.
  const recents = projects.filter((p) => p.id !== project.id).slice(0, 4);

  return (
    <div className="card continue-card">
      <div className="continue-card-head">
        <div className="continue-card-icon">
          <Icon name="play" size={20} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="overline">PICK UP WHERE YOU LEFT OFF</div>
          <h3 className="continue-card-title">
            <span className="muted">{space?.name ?? 'Space'} ›</span> {project.name}
          </h3>
          {project.goal && <p className="muted clamp small">{project.goal}</p>}
          <p className="muted small">
            <Icon name="calendar" size={13} /> Last active{' '}
            {new Date(project.lastActiveAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="cta-row continue-card-actions">
        <Link to={dest(project.id)} className="cta">
          <Icon name={defaultMode === 'quiz' ? 'quiz' : defaultMode === 'tutor' ? 'tutor' : 'play'} size={15} />
          {defaultMode === 'quiz' ? 'Start a quiz' : defaultMode === 'tutor' ? 'Ask the Tutor' : 'Continue project'}
        </Link>
        {secondary.map((a) => (
          <Link key={a.to} to={a.to} className="cta-ghost">
            <Icon name={a.icon} size={15} />
            {a.label}
          </Link>
        ))}
        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Change space or project'}
        </button>
      </div>

      {open && (
        <ProjectSwitcher
          spaces={spaces}
          projects={projects}
          projectId={project.id}
          submitLabel={defaultMode === 'quiz' ? 'Start quiz' : defaultMode === 'tutor' ? 'Open Tutor' : 'Open project'}
          onPick={(p) => {
            setOpen(false);
            navigate(dest(p.id));
          }}
        />
      )}

      {showRecents && recents.length > 0 && (
        <div className="continue-recents">
          <span className="muted small">Or continue in</span>
          {recents.map((p) => (
            <Link key={p.id} to={dest(p.id)} className="pill continue-recent">
              <Icon name="folder" size={13} />
              {p.name}
              <span className="muted">
                {spaces.find((s) => s.id === p.spaceId)?.name ?? ''}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
