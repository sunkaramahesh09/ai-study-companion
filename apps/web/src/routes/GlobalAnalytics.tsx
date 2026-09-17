import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGlobalAnalytics, type GlobalAnalytics as Data } from '../lib/queries.ts';
import { EmptyState, ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';
import { RowBars, Stat, pct } from '../components/Charts.tsx';
import {
  ActivityPanel,
  AiUsagePanel,
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
      <Link to="/home" className="back">← Back to Home</Link>

      <PageHeader
        icon={<Icon name="chart-bar" size={26} />}
        title="Global Analytics"
        description="Everything across your Spaces and Projects."
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
                rows={active.map((p) => ({ label: p.name, value: p.events }))}
                formatValue={(n) => `${n} event${n === 1 ? '' : 's'}`}
              />
            )}
            <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
              Every global figure above is the sum of these projects — the numbers stay traceable to
              where they came from.
            </p>
          </div>

          <AssessmentPanel assessment={data.assessment} />
          <TutorPanel tutor={data.tutor} />
          <AiUsagePanel ai={data.ai} />
        </>
      )}
    </section>
  );
}
