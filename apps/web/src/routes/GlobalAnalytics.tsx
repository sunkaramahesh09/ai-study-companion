import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGlobalAnalytics, type GlobalAnalytics as Data } from '../lib/queries.ts';
import { EmptyState, ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';
import { RowBars, Stat, pct } from '../components/Charts.tsx';
import {
  ActivityPanel,
  AssessmentPanel,
  TutorPanel,
  WindowPicker,
} from '../components/AnalyticsPanels.tsx';
import { Icon } from '../components/Icon.tsx';

export function GlobalAnalytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    getGlobalAnalytics(days).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  const active = data.projects.filter((p) => p.events > 0);

  return (
    <section className="fade-in">
      <Link to="/progress" className="back">← Back to Progress</Link>

      <PageHeader
        icon={<Icon name="chart-bar" size={26} />}
        title="Global Analytics"
        description="Everything across your Spaces and Projects. Open any project below for its own view."
        action={<WindowPicker days={days} onChange={setDays} />}
      />

      {data.totals.projects === 0 ? (
        <EmptyState
          icon={<Icon name="chart-bar" size={26} />}
          title="Nothing to measure yet"
          hint="Create a Space and a Project, add some material, and your activity will show up here."
        />
      ) : (
        <>
          <div className="stats stagger">
            <Stat value={data.totals.spaces} label="spaces" />
            <Stat value={data.totals.projects} label="projects" />
            <Stat value={active.length} label="active in window" />
            <Stat value={pct(data.assessment.accuracy)} label="overall accuracy" />
          </div>

          <ActivityPanel activity={data.activity} days={data.window.days} />

          <div className="card">
            <div className="card-head">
              <h3>Activity by Project</h3>
              <span className="muted small">last {data.window.days} days</span>
            </div>
            {active.length === 0 ? (
              <p className="muted">No project activity in this window.</p>
            ) : (
              <RowBars
                // Each row links into that project's own analytics. This page
                // is a sum; the per-Project view (PRD §12) is where the detail
                // lives, and clicking the thing you are reading about is how a
                // learner expects to get there.
                rows={active.map((p) => ({
                  label: p.name,
                  value: p.events,
                  href: `/projects/${p.id}/analytics`,
                }))}
                formatValue={(n) => `${n} event${n === 1 ? '' : 's'}`}
              />
            )}
            <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
              Every global figure above is the sum of these projects — the numbers stay traceable to
              where they came from. Open a project's name for its own analytics: mastery, quiz
              attempts and what the AI did for it.
            </p>
          </div>

          <AssessmentPanel assessment={data.assessment} />
          {/* No AI usage panel here, on purpose. Token spend, model mix and
              dollar cost across a whole account is an operational view — it
              belongs to the Admin Dashboard (PRD §16), and on the per-Project
              view where the PRD asks for it (§12). Nothing a learner decides
              changes because of it. See D-076. */}
          <TutorPanel tutor={data.tutor} />
        </>
      )}
    </section>
  );
}
