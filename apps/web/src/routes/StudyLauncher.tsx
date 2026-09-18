import { Link } from 'react-router-dom';
import { ContinueCard } from '../components/StudyContext.tsx';
import { PageHeader } from '../components/Ui.tsx';
import { Icon } from '../components/Icon.tsx';

/**
 * Landing page for the sidebar's Quizzes / Ask Tutor entries.
 *
 * Both features are per-project, and these links used to redirect to Spaces —
 * correct, but it made every quiz a three-click walk through a hierarchy the
 * learner had just been in. This leads with the last used space and project
 * instead, so continuing is one click, and keeps switching right there.
 *
 * It deliberately does *not* auto-redirect into the last project: starting a
 * quiz generates a question, and navigation should never spend model quota on
 * the learner's behalf (the same rule as the Tutor's prefilled ?q=, which is never auto-sent).
 */
export function StudyLauncher({ mode }: { mode: 'quiz' | 'tutor' }) {
  const isQuiz = mode === 'quiz';

  return (
    <section className="fade-in">
      <PageHeader
        icon={<Icon name={isQuiz ? 'quiz' : 'tutor'} size={26} />}
        title={isQuiz ? 'Quizzes' : 'Ask Tutor'}
        description={
          isQuiz
            ? 'Quizzes run inside a project, so the questions come from that project’s material.'
            : 'The Tutor answers from one project’s material, with the page it came from.'
        }
        action={
          <Link to="/spaces" className="cta-ghost">
            <Icon name="folder" size={15} /> All Spaces
          </Link>
        }
      />

      <ContinueCard defaultMode={mode} showRecents />
    </section>
  );
}
