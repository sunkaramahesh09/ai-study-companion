import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.tsx';
import {
  getAdminActivity,
  getAdminAi,
  getAdminEvals,
  getAdminOverview,
  getAdminUsers,
  type AdminEvent,
  type AdminOverview,
  type AdminUser,
  type AiFailure,
  type AiUsageSummary,
  type EvalResult,
  type EvalRun,
} from '../lib/queries.ts';
import { EmptyState, ErrorNote, Spinner, PageHeader } from '../components/Ui.tsx';
import { RowBars, Stat, pct } from '../components/Charts.tsx';
import { ActivityPanel, AiUsagePanel, TutorPanel, WindowPicker } from '../components/AnalyticsPanels.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';

type Tab = 'overview' | 'users' | 'activity' | 'ai' | 'evaluation';

const TABS: { id: Tab; icon: IconName; label: string }[] = [
  { id: 'overview', icon: 'clipboard', label: 'Overview' },
  { id: 'users', icon: 'users', label: 'Users' },
  { id: 'activity', icon: 'chart-bar', label: 'Activity' },
  { id: 'ai', icon: 'tutor', label: 'AI' },
  { id: 'evaluation', icon: 'flask', label: 'Evaluation' },
];

export function Admin() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(30);

  if (profile && profile.role !== 'admin') {
    return (
      <section className="fade-in">
        <Link to="/home" className="back">← Back to Home</Link>
        <EmptyState
          icon={<Icon name="lock" size={26} />}
          title="Administrator access required"
          hint="Your account does not have the admin role. This page is gated on the server too — there is nothing to see here without it."
        />
      </section>
    );
  }

  return (
    <section className="fade-in">
      <Link to="/home" className="back">← Back to Home</Link>

      <PageHeader
        icon={<Icon name="settings" size={26} />}
        title="Admin Dashboard"
        description="Users, learning activity, AI usage and system health."
        action={tab !== 'users' && tab !== 'evaluation' ? <WindowPicker days={days} onChange={setDays} /> : undefined}
      />

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab tab-on' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab days={days} />}
      {tab === 'users' && <UsersTab />}
      {tab === 'activity' && <ActivityTab days={days} />}
      {tab === 'ai' && <AiTab days={days} />}
      {tab === 'evaluation' && <EvaluationTab />}
    </section>
  );
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    load().then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

function OverviewTab({ days }: { days: number }) {
  const { data, error } = useAsync<AdminOverview>(() => getAdminOverview(days), [days]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
      <div className="stats stagger">
        <Stat value={data.users.total} label="users" />
        <Stat value={data.users.newInWindow} label={`new in ${days}d`} />
        <Stat value={data.content.spaces} label="spaces" />
        <Stat value={data.content.projects} label="projects" />
        <Stat value={data.content.materials} label="materials" />
        <Stat value={`$${data.ai.estimatedCostUsd.toFixed(4)}`} label="AI cost" />
      </div>

      <div className="two-col">
        <div className="card">
          <h3>Material Pipeline</h3>
          <RowBars
            rows={Object.entries(data.content.materialsByStatus).map(([status, n]) => ({
              label: status,
              value: n,
            }))}
          />
          <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
            Material status is the pipeline's user-visible truth. A material stuck in
            <code> processing </code> while the queue is empty means a worker died mid-job.
          </p>
        </div>

        <div className="card">
          <h3>Job Queues</h3>
          {!data.jobs.available ? (
            <p className="error small">Queue unreachable: {data.jobs.error}</p>
          ) : data.jobs.queues.length === 0 ? (
            <p className="muted">No queues registered yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Queue</th><th>Queued</th><th>Active</th><th>Failed</th></tr>
              </thead>
              <tbody>
                {data.jobs.queues.map((q) => (
                  <tr key={q.name}>
                    <td className="mono small">{q.name}</td>
                    <td>{q.queued}</td>
                    <td>{q.active}</td>
                    <td className={q.failed > 0 ? 'error' : undefined}>{q.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
            Failed counts are bounded by the queue's retention policy — a rolling recent count, not an
            all-time total.
          </p>
        </div>
      </div>

      <ActivityPanel activity={data.activity} days={data.window.days} />
      <TutorPanel tutor={data.tutor} />
      <AiUsagePanel ai={data.ai} />
    </div>
  );
}

function UsersTab() {
  const { data, error } = useAsync<AdminUser[]>(() => getAdminUsers(), []);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  return (
    <div className="card fade-in" style={{ marginTop: 'var(--space-4)' }}>
      <div className="card-head">
        <h3>Users</h3>
        <span className="muted small">{data.length} total</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Email</th><th>Role</th><th>Spaces</th><th>Projects</th>
            <th>Events</th><th>Tokens</th><th>Cost</th><th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {data.map((u) => (
            <tr key={u.id}>
              <td className="clamp">{u.email ?? '—'}</td>
              <td>{u.role === 'admin' ? <span className="badge">admin</span> : 'user'}</td>
              <td>{u.spaces}</td>
              <td>{u.projects}</td>
              <td>{u.events}</td>
              <td>{u.tokens.toLocaleString()}</td>
              <td>${u.estimatedCostUsd.toFixed(5)}</td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVENT_TYPES = [
  'project_created', 'material_uploaded', 'material_ready', 'material_failed',
  'tutor_question', 'tutor_answer', 'tutor_unsupported',
  'quiz_started', 'question_answered', 'quiz_completed',
  'mastery_updated', 'weakness_detected', 'recommendation_created',
];

function ActivityTab({ days }: { days: number }) {
  const [type, setType] = useState('');
  const { data, error } = useAsync<AdminEvent[]>(
    () => getAdminActivity({ days, type: type || undefined }),
    [days, type],
  );

  return (
    <div className="card fade-in" style={{ marginTop: 'var(--space-4)' }}>
      <div className="card-head">
        <h3>Activity</h3>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All event types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      {error ? (
        <ErrorNote error={error} />
      ) : !data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <p className="muted">No events match those filters.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>When</th><th>Event</th><th>User</th><th>Project</th></tr>
          </thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td className="mono small">{e.event_type}</td>
                <td className="mono small">{e.user_id.slice(0, 8)}</td>
                <td className="mono small">{e.project_id ? e.project_id.slice(0, 8) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AiTab({ days }: { days: number }) {
  const { data, error } = useAsync<{ summary: AiUsageSummary; recentFailures: AiFailure[] }>(
    () => getAdminAi(days),
    [days],
  );
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
      <AiUsagePanel ai={data.summary} />
      <div className="card">
        <div className="card-head">
          <h3>Recent Failures</h3>
          <span className="muted small">{data.recentFailures.length} in {days}d</span>
        </div>
        {data.recentFailures.length === 0 ? (
          <p className="muted">No failed AI requests in this window.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th><th>Feature</th><th>Model</th><th>Status</th>
                <th>Attempts</th><th>Latency</th><th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFailures.map((f) => (
                <tr key={f.id}>
                  <td>{new Date(f.created_at).toLocaleString()}</td>
                  <td>{f.feature}</td>
                  <td className="mono small">{f.model}</td>
                  <td className="error">{f.status}</td>
                  <td>{f.attempt_count}</td>
                  <td>{f.latency_ms === null ? '—' : `${f.latency_ms} ms`}</td>
                  <td className="clamp" title={f.error_message ?? ''}>
                    {f.error_code ?? f.error_message ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
          A high attempt count with a 429 means the request was rate-limited and retried through
          backoff — the early signal of pressing against the TPM ceiling.
        </p>
      </div>
    </div>
  );
}

function EvaluationTab() {
  const { data, error } = useAsync<{ runs: EvalRun[]; latestResults: EvalResult[] }>(
    () => getAdminEvals(),
    [],
  );
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;

  if (data.runs.length === 0) {
    return (
      <div className="card fade-in" style={{ marginTop: 'var(--space-4)' }}>
        <EmptyState
          icon={<Icon name="flask" size={26} />}
          title="No evaluation has been run yet"
          hint="Run `npm run eval` to score the Tutor's groundedness and citation correctness, retrieval relevance, unsupported-question handling and grading quality. Results are persisted and appear here."
        />
      </div>
    );
  }

  const bySuite = new Map<string, EvalResult[]>();
  for (const r of data.latestResults) {
    bySuite.set(r.suite, [...(bySuite.get(r.suite) ?? []), r]);
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
      <div className="card">
        <h3>Runs</h3>
        <table className="table">
          <thead>
            <tr><th>Started</th><th>Commit</th><th>Duration</th><th>Result</th></tr>
          </thead>
          <tbody>
            {data.runs.map((r) => {
              const suites = Object.values(r.summary ?? {});
              const passed = suites.reduce((s, v) => s + (v.passed ?? 0), 0);
              const failed = suites.reduce((s, v) => s + (v.failed ?? 0), 0);
              return (
                <tr key={r.id}>
                  <td>{new Date(r.started_at).toLocaleString()}</td>
                  <td className="mono small">{r.git_sha ? r.git_sha.slice(0, 7) : '—'}</td>
                  <td>
                    {r.finished_at
                      ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
                      : '—'}
                  </td>
                  <td>
                    {r.incomplete ? (
                      <span className="warn">did not finish</span>
                    ) : (
                      <>
                        <span className="ok">{passed} passed</span>
                        {failed > 0 && <span className="error"> · {failed} failed</span>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {[...bySuite.entries()].map(([suite, results]) => (
        <div className="card" key={suite}>
          <div className="card-head">
            <h3>{suite}</h3>
            <span className="muted small">
              {results.filter((r) => r.passed).length}/{results.length} passed
            </span>
          </div>
          <table className="table">
            <thead>
              <tr><th>Case</th><th>Passed</th><th>Score</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.case_id}</td>
                  <td className={r.passed ? 'ok' : 'error'}>{r.passed ? 'pass' : 'FAIL'}</td>
                  <td>{r.score === null ? '—' : pct(r.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
