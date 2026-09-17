import { BarChart, RowBars, Stat, pct, type Bar } from './Charts.tsx';
import type { ActivitySummary, AiUsageSummary, AssessmentSummary, TutorSummary } from '../lib/queries.ts';

/**
 * Panels shared by Project and Global analytics.
 *
 * Both views answer the same questions at different scopes, so the rendering
 * lives in one place — a number that means one thing on a project and another
 * globally would be a bug the UI could not show you.
 */

const EVENT_LABELS: Record<string, string> = {
  space_created: 'Spaces created',
  project_created: 'Projects created',
  material_uploaded: 'Materials uploaded',
  material_ready: 'Materials processed',
  material_failed: 'Processing failures',
  tutor_question: 'Tutor questions',
  tutor_answer: 'Tutor answers',
  tutor_unsupported: 'Tutor declined',
  quiz_started: 'Quizzes started',
  question_answered: 'Questions answered',
  quiz_completed: 'Quizzes completed',
  mastery_updated: 'Mastery updates',
  weakness_detected: 'Weaknesses detected',
  recommendation_created: 'Recommendations',
};

const FEATURE_LABELS: Record<string, string> = {
  tutor_answer: 'Tutor answers',
  concept_extraction: 'Concept extraction',
  question_generation: 'Question generation',
  open_answer_grading: 'Answer grading',
  recommendation: 'Recommendations',
  embedding: 'Embeddings',
  evaluation: 'Evaluation',
};

/** `2026-09-17` → `17 Sep`, for a tooltip a person can read. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function ActivityPanel({ activity, days }: { activity: ActivitySummary; days: number }) {
  const bars: Bar[] = activity.buckets.map((b) => ({
    label: dayLabel(b.date),
    value: b.total,
    detail: Object.entries(b.byType)
      .sort((a, x) => x[1] - a[1])
      .map(([type, n]) => `${EVENT_LABELS[type] ?? type}: ${n}`)
      .join('\n'),
  }));

  const breakdown: Bar[] = Object.entries(activity.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, n]) => ({ label: EVENT_LABELS[type] ?? type, value: n }));

  return (
    <div className="card">
      <div className="card-head">
        <h3>Learning activity</h3>
        <span className="muted small">last {days} days</span>
      </div>

      <div className="stats">
        <Stat value={activity.totalEvents} label="events" />
        <Stat value={activity.streak.current} label="day streak" hint="Consecutive days with activity. Today being empty does not break it." />
        <Stat value={activity.streak.longest} label="longest streak" />
        <Stat value={activity.streak.activeDays} label={`active days of ${days}`} />
      </div>

      <BarChart bars={bars} formatValue={(n) => `${n} event${n === 1 ? '' : 's'}`} />
      <p className="muted small chart-caption">
        {bars[0]?.label} → {bars.at(-1)?.label} · hover a day for the breakdown
      </p>

      {breakdown.length > 0 && (
        <>
          <h4 className="panel-sub">What happened</h4>
          <RowBars rows={breakdown} />
        </>
      )}
    </div>
  );
}

export function AssessmentPanel({ assessment }: { assessment: AssessmentSummary }) {
  const difficultyBars: Bar[] = assessment.byDifficulty.map((d) => ({
    label: `Level ${d.difficulty}`,
    value: d.accuracy === null ? 0 : Math.round(d.accuracy * 100),
    detail: `${d.correct} of ${d.answered} correct`,
  }));

  // Only shown when there is enough on both sides to compare honestly; the
  // server returns null otherwise rather than a number built from two answers.
  const trend =
    assessment.recentAccuracy !== null && assessment.priorAccuracy !== null
      ? assessment.recentAccuracy - assessment.priorAccuracy
      : null;

  return (
    <div className="card">
      <h3>Assessment performance</h3>
      {assessment.answered === 0 ? (
        <p className="muted">No questions answered yet.</p>
      ) : (
        <>
          <div className="stats">
            <Stat value={pct(assessment.accuracy)} label="overall accuracy" />
            <Stat value={assessment.answered} label="questions answered" />
            <Stat
              value={assessment.averageDifficulty}
              label="average difficulty"
              hint="Out of 5. Chosen by the adaptive selector, not by the last answer."
            />
            {trend !== null && (
              <Stat
                value={`${trend >= 0 ? '+' : ''}${Math.round(trend * 100)} pts`}
                label="recent vs earlier"
                tone={trend >= 0 ? 'ok' : 'error'}
                hint="Accuracy over the last 10 answers against everything before them."
              />
            )}
          </div>

          <h4 className="panel-sub">Accuracy by difficulty</h4>
          <RowBars rows={difficultyBars} formatValue={(n) => `${n}%`} />

          <h4 className="panel-sub">By question format</h4>
          <table className="table">
            <thead>
              <tr><th>Format</th><th>Answered</th><th>Correct</th><th>Accuracy</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Multiple choice</td>
                <td>{assessment.byType.mcq.answered}</td>
                <td>{assessment.byType.mcq.correct}</td>
                <td>{pct(assessment.byType.mcq.accuracy) ?? '—'}</td>
              </tr>
              <tr>
                <td>Open-ended</td>
                <td>{assessment.byType.open.answered}</td>
                <td>{assessment.byType.open.correct}</td>
                <td>{pct(assessment.byType.open.accuracy) ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function TutorPanel({ tutor }: { tutor: TutorSummary }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Tutor</h3>
      </div>
      {tutor.answered + tutor.refused === 0 ? (
        <p className="muted">The Tutor has not been asked anything yet.</p>
      ) : (
        <>
          <div className="stats">
            <Stat value={tutor.answered} label="grounded answers" />
            <Stat value={tutor.refused} label="declined" />
            <Stat value={pct(tutor.rate)} label="answered with evidence" />
          </div>
          <p className="muted small">
            Declining is correct behaviour, not an error: the Tutor answers only from your material and
            says so when the material does not cover the question.
          </p>
        </>
      )}
    </div>
  );
}

export function AiUsagePanel({ ai }: { ai: AiUsageSummary }) {
  return (
    <div className="card">
      <h3>AI activity</h3>
      {ai.requests === 0 ? (
        <p className="muted">No AI requests in this window.</p>
      ) : (
        <>
          <div className="stats">
            <Stat value={ai.requests} label="requests" />
            <Stat value={pct(ai.successRate)} label="success rate" tone={ai.failures > 0 ? 'error' : undefined} />
            <Stat value={ai.totalTokens.toLocaleString()} label="tokens" />
            <Stat
              value={`$${ai.estimatedCostUsd.toFixed(4)}`}
              label="estimated cost"
              hint="Estimated from token counts and published per-model rates."
            />
            <Stat
              value={ai.medianLatencyMs === null ? null : `${ai.medianLatencyMs} ms`}
              label="median latency"
              hint="Successful requests only — a rate-limited retry says nothing about model speed."
            />
            <Stat value={ai.p95LatencyMs === null ? null : `${ai.p95LatencyMs} ms`} label="p95 latency" />
          </div>

          <h4 className="panel-sub">Where the tokens went</h4>
          <table className="table">
            <thead>
              <tr><th>Feature</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {ai.byFeature.map((f) => (
                <tr key={f.feature}>
                  <td>{FEATURE_LABELS[f.feature] ?? f.feature}</td>
                  <td>{f.requests}</td>
                  <td>{f.totalTokens.toLocaleString()}</td>
                  <td>${f.estimatedCostUsd.toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="panel-sub">By model</h4>
          <table className="table">
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Tokens</th></tr>
            </thead>
            <tbody>
              {ai.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="mono small">{m.model}</td>
                  <td>{m.requests}</td>
                  <td>{m.totalTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ai.fallbackRate !== null && ai.fallbackRate > 0 && (
            <p className="muted small">
              {pct(ai.fallbackRate)} of requests used the fallback model after the primary was rate-limited.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Shared window selector. One row, above the charts. */
export function WindowPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="window-picker">
      {[7, 30, 90].map((d) => (
        <button
          key={d}
          type="button"
          className={d === days ? 'chip chip-on' : 'chip'}
          onClick={() => onChange(d)}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}
