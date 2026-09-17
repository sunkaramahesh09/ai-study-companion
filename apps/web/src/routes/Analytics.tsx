import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProjectAnalytics, type ProjectAnalytics } from '../lib/queries.ts';
import { ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';
import { Stat, pct } from '../components/Charts.tsx';
import {
  ActivityPanel,
  AiUsagePanel,
  AssessmentPanel,
  TutorPanel,
  WindowPicker,
} from '../components/AnalyticsPanels.tsx';

export function Analytics() {
  const { projectId } = useParams<{ projectId: string }>();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ProjectAnalytics | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getProjectAnalytics(projectId, days).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, days]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  return (
    <section className="fade-in">
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>

      <PageHeader
        icon="📊"
        title="Analytics"
        description={data.project.name}
        action={<WindowPicker days={days} onChange={setDays} />}
      />

      <div className="stats stagger">
        <Stat value={data.mastery.concepts} label="concepts" />
        <Stat value={data.mastery.assessed} label="assessed" />
        <Stat
          value={pct(data.mastery.average)}
          label="average mastery"
          hint="Across assessed concepts only — untested concepts are not averaged in as 50%."
        />
        <Stat value={data.assessment.attempts.completed} label="quizzes completed" />
        <Stat
          value={pct(data.assessment.attempts.averageScore)}
          label="average quiz score"
          hint="Completed attempts only. Walking away from a quiz is not scored as failing it."
        />
      </div>

      <ActivityPanel activity={data.activity} days={data.window.days} />
      <AssessmentPanel assessment={data.assessment} />
      <div className="two-col">
        <TutorPanel tutor={data.tutor} />
        <div className="card">
          <h3>Quiz Attempts</h3>
          <div className="stats">
            <Stat value={data.assessment.attempts.total} label="started" />
            <Stat value={data.assessment.attempts.completed} label="completed" />
            <Stat value={data.assessment.attempts.abandoned} label="abandoned" />
            <Stat value={data.assessment.attempts.inProgress} label="in progress" />
          </div>
          <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
            An abandoned attempt keeps the answers already given — mastery earned before you stopped is
            not discarded.
          </p>
        </div>
      </div>
      <AiUsagePanel ai={data.ai} />
    </section>
  );
}
