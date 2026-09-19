import { Link } from 'react-router-dom';
import { ContinueCardView, ProjectGrid } from '../components/StudyContext.tsx';
import { PageHeader, ErrorNote, Spinner } from '../components/Ui.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { useStudyContext } from '../lib/studyContext.ts';

type Mode = 'quiz' | 'tutor' | 'analytics' | 'flashcards';

const COPY: Record<Mode, { icon: IconName; title: string; description: string }> = {
  quiz: {
    icon: 'quiz',
    title: 'Quizzes',
    description: 'Quizzes run inside a project, so the questions come from that project’s material.',
  },
  tutor: {
    icon: 'tutor',
    title: 'Ask Tutor',
    description: 'The Tutor answers from one project’s material, with the page it came from.',
  },
  flashcards: {
    icon: 'cards',
    title: 'Flashcards',
    description:
      'Cards are written from one project’s material and come back on a schedule set by how well you recall them.',
  },
  analytics: {
    icon: 'chart-bar',
    title: 'Progress',
    description:
      'Mastery, quiz attempts, Tutor use and AI activity are measured per project — that is where studying actually happens.',
  },
};

/**
 * Landing page for the sidebar's Quizzes / Ask Tutor / Progress entries.
 *
 * All three features are per-project, and these links used to redirect
 * elsewhere — Quizzes and the Tutor to Spaces, Progress straight to the
 * account-wide analytics page. Correct destinations, but between them they
 * meant the per-Project analytics the PRD asks for (§12) had exactly one
 * entrance, a button on the project dashboard, and a learner navigating from
 * the rail never saw it at all (D-079).
 *
 * This leads with the last used space and project instead, so continuing is
 * one click, then indexes every other project so the page answers "somewhere
 * else" too rather than being a single card on white.
 *
 * It deliberately does *not* auto-redirect into the last project: starting a
 * quiz generates a question, and navigation should never spend model quota on
 * the learner's behalf (the same rule as the Tutor's prefilled ?q=, which is
 * never auto-sent).
 */
export function StudyLauncher({ mode }: { mode: Mode }) {
  const ctx = useStudyContext();
  const copy = COPY[mode];

  return (
    <section className="fade-in">
      <PageHeader
        icon={<Icon name={copy.icon} size={26} />}
        title={copy.title}
        description={copy.description}
        action={
          mode === 'analytics' ? (
            // The account-wide roll-up is still a click away, just no longer
            // the only thing "Progress" can mean.
            <Link to="/analytics" className="cta-ghost">
              <Icon name="chart-bar" size={15} /> Across all spaces
            </Link>
          ) : (
            <Link to="/spaces" className="cta-ghost">
              <Icon name="folder" size={15} /> All Spaces
            </Link>
          )
        }
      />

      {/* One gate for the card and the index below it, so the page arrives in
          a single frame instead of growing under the learner. */}
      {ctx.loading && !ctx.error && <Spinner />}
      {ctx.error ? <ErrorNote error={ctx.error} /> : null}

      {!ctx.loading && !ctx.error && (
        <>
          <ContinueCardView ctx={ctx} defaultMode={mode} />
          <ProjectGrid ctx={ctx} mode={mode} />
        </>
      )}
    </section>
  );
}
