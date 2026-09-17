import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../lib/api.ts';
import {
  abandonQuiz,
  answerQuiz,
  getQuizAttempt,
  nextQuizQuestion,
  startQuiz,
  type AnswerResult,
  type QuizQuestion,
} from '../lib/queries.ts';
import { ErrorNote, Spinner, ProgressRing, PageHeader } from '../components/Ui.tsx';
import { Icon } from '../components/Icon.tsx';

export function Quiz() {
  const { projectId } = useParams<{ projectId: string }>();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(true);
  const [finished, setFinished] = useState<{ score: number; answered: number } | null>(null);
  // Separate from `busy`: grading is instant, generating the next question is
  // not, and conflating them is what made the verdict feel slow.
  const [loadingNext, setLoadingNext] = useState(false);
  const [nextQuestion, setNextQuestion] = useState<QuizQuestion | null>(null);
  // Set only when we're showing a quiz resumed from a 409 conflict, so the
  // "start over" affordance only appears in that situation.
  const [resumed, setResumed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  function load(projId: string) {
    setStarting(true);
    setError(null);
    startQuiz(projId, 5)
      .then((r) => {
        setAttemptId(r.attempt.id);
        setQuestion(r.question);
        setResumed(false);
      })
      .catch(async (err: unknown) => {
        // A learner already has an attempt in progress for this project — the
        // API returns 409 with the attemptId rather than starting a new one
        // (one open attempt per project). Resume it instead of dead-ending on
        // an error card with no way to reach the quiz that is supposedly
        // "already in progress".
        const openAttemptId =
          err instanceof ApiError && err.status === 409 && typeof err.body?.attemptId === 'string'
            ? err.body.attemptId
            : null;
        if (!openAttemptId) {
          setError(err);
          return;
        }
        try {
          const { attempt, questions } = await getQuizAttempt(openAttemptId);
          const pending = questions.find((q) => !q.answered_at) ?? null;
          if (pending) {
            setAttemptId(attempt.id);
            setQuestion(pending);
            setResumed(true);
            return;
          }
          // Every issued question is answered but the attempt is still
          // in_progress (e.g. interrupted right after grading) — ask for the
          // next one the same way normal play does.
          const next = await nextQuizQuestion(attempt.id);
          if (next.question) {
            setAttemptId(attempt.id);
            setQuestion(next.question);
            setResumed(true);
          } else {
            setFinished({ score: next.score ?? 0, answered: attempt.questions_answered });
          }
        } catch (resumeErr) {
          setError(resumeErr);
        }
      })
      .finally(() => setStarting(false));
  }

  useEffect(() => {
    if (!projectId) return;
    load(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function startOver() {
    if (!attemptId || !projectId || restarting) return;
    setRestarting(true);
    try {
      await abandonQuiz(attemptId);
      setAttemptId(null);
      setQuestion(null);
      setResult(null);
      setSelected(null);
      setText('');
      setNextQuestion(null);
      setResumed(false);
      load(projectId);
    } catch (err) {
      setError(err);
    } finally {
      setRestarting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!attemptId || !question || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        question.question_type === 'mcq'
          ? { questionId: question.id, selectedIndex: selected! }
          : { questionId: question.id, text: text.trim() };
      const r = await answerQuiz(attemptId, body);
      setResult(r);
      if (r.finished) {
        setFinished({ score: r.progress.correct / r.progress.answered, answered: r.progress.answered });
        return;
      }
      // An API that still returns the next question inline (an older deploy,
      // or this bundle loaded against one) is handled without a round trip.
      // Deploy skew is normal for the few minutes between the API and the
      // frontend going out, and the Next button must not hang during it.
      if (r.question) {
        setNextQuestion(r.question);
        return;
      }

      // The verdict is already on screen. Fetch the next question in the
      // background while the learner reads their feedback — by the time they
      // reach for "Next question" it is usually already here.
      if (r.nextPending !== false) {
        setLoadingNext(true);
        nextQuizQuestion(attemptId)
          .then((n) => {
            if (n.finished || !n.question) {
              setFinished({
                score: n.score ?? r.progress.correct / r.progress.answered,
                answered: r.progress.answered,
              });
            } else {
              setNextQuestion(n.question);
            }
          })
          .catch(setError)
          .finally(() => setLoadingNext(false));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (!nextQuestion) return;
    setQuestion(nextQuestion);
    setNextQuestion(null);
    setResult(null);
    setSelected(null);
    setText('');
  }

  if (starting) return <Spinner label="Preparing your quiz…" />;

  if (error && !question) {
    return (
      <section className="fade-in">
        <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>
        <div className="card" style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
          <span style={{ fontSize: 48, marginBottom: 'var(--space-3)', display: 'block' }}><Icon name="note" size={16} /></span>
          <h2>Can't start a quiz yet</h2>
          <ErrorNote error={error} />
          <p className="muted" style={{ marginTop: 'var(--space-3)', maxWidth: 420, margin: 'var(--space-3) auto' }}>
            A quiz needs concepts, which come from processed material. Upload a PDF and wait for it to
            finish processing.
          </p>
          <Link to={`/projects/${projectId}`} className="cta" style={{ marginTop: 'var(--space-3)' }}>
            Go to Project
          </Link>
        </div>
      </section>
    );
  }

  if (finished) {
    const scorePct = Math.round(finished.score * 100);
    return (
      <section className="fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-5)', paddingTop: 'var(--space-8)' }}>
        <div className="card" style={{ textAlign: 'center', maxWidth: 480, width: '100%', padding: 'var(--space-8)' }}>
          <span style={{ fontSize: 56, display: 'block', marginBottom: 'var(--space-3)' }}>
            <Icon name={scorePct >= 80 ? 'trophy' : scorePct >= 60 ? 'star' : 'book'} size={56} />
          </span>
          <h2>Quiz Complete!</h2>
          <div style={{ display: 'flex', justifyContent: 'center', margin: 'var(--space-5) 0' }}>
            <ProgressRing
              value={finished.score}
              size={140}
              label="Score"
              color={scorePct >= 80 ? 'var(--ok)' : scorePct >= 60 ? 'var(--warning-500)' : 'var(--error)'}
            />
          </div>
          <p className="muted">{finished.answered} questions answered.</p>
          <p className="muted small" style={{ marginTop: 'var(--space-2)' }}>
            Your mastery estimates are updating now, and a recommendation is being prepared in the
            background — you don't need to wait here.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', marginTop: 'var(--space-5)' }}>
            <Link to={`/projects/${projectId}/growth`} className="cta"><Icon name="trend-up" size={15} /> See your growth</Link>
            <Link to={`/projects/${projectId}`} className="cta-ghost">Back to project</Link>
          </div>
        </div>
      </section>
    );
  }

  const canSubmit =
    question?.question_type === 'mcq' ? selected !== null : text.trim().length >= 10;

  return (
    <section className="fade-in">
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>

      <PageHeader
        icon={<Icon name="check-circle" size={26} />}
        title="Quiz"
        description="Test your understanding and track your mastery."
      />

      {question && (
        <div className="card" style={{ marginTop: 'var(--space-3)' }}>
          {resumed && (
            <p className="muted small" style={{ marginBottom: 'var(--space-3)' }}>
              Continuing your quiz already in progress.{' '}
              <button type="button" className="link" onClick={startOver} disabled={restarting}>
                {restarting ? 'Starting over…' : 'Start a new quiz instead'}
              </button>
            </p>
          )}

          {/* Question Header */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
            <span className="pill" style={{ background: 'var(--lavender-50)', color: 'var(--primary-600)', borderColor: 'var(--lavender-200)' }}>
              <Icon name="brain" size={14} /> {question.conceptName ?? 'Concept'}
            </span>
            <span className="pill">
              <Icon name="star" size={13} /> Difficulty {question.difficulty}/5
            </span>
            <span className="pill">
              <Icon name={question.question_type === 'open' ? 'note' : 'check-circle'} size={13} />{' '}
                {question.question_type === 'open' ? 'Written Answer' : 'Multiple Choice'}
            </span>
          </div>

          <h2 style={{ fontSize: 'var(--text-xl)', lineHeight: 1.4, marginBottom: 'var(--space-5)' }}>
            {question.prompt}
          </h2>

          {/* Answer Form */}
          {!result && (
            <form onSubmit={submit} className="stack">
              {question.question_type === 'mcq' ? (
                <div className="options">
                  {(question.options ?? []).map((opt, i) => (
                    <label key={i} className={`option ${selected === i ? 'option-selected' : ''}`}>
                      <input
                        type="radio"
                        name="answer"
                        checked={selected === i}
                        onChange={() => setSelected(i)}
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <>
                  <textarea
                    rows={6}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Explain in your own words…"
                    maxLength={4000}
                  />
                  <span className="muted small">
                    A few sentences. You'll get feedback on what you covered and what was missing.
                  </span>
                </>
              )}
              <button type="submit" disabled={!canSubmit || busy}>
                <Icon name={busy ? 'clock' : 'arrow-right'} size={15} /> {busy ? 'Checking…' : 'Submit Answer'}
              </button>
            </form>
          )}

          {error ? <ErrorNote error={error} /> : null}

          {/* Result */}
          {result && (
            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <div className={result.isCorrect ? 'verdict verdict-ok' : 'verdict verdict-no'}>
                {result.questionType === 'open'
                  ? `Scored ${Math.round(result.score * 100)}%`
                  : result.isCorrect
                    ? 'Correct!'
                    : 'Not quite'}
              </div>

              {result.questionType === 'mcq' && result.correctIndex !== undefined && (
                <div style={{
                  padding: 'var(--space-4)',
                  background: 'var(--success-50)',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--success-100)',
                }}>
                  <p>
                    <strong><Icon name="check-circle" size={15} /> Correct answer:</strong> {(question.options ?? [])[result.correctIndex]}
                    {result.explanation ? <><br /><span className="muted">{result.explanation}</span></> : null}
                  </p>
                </div>
              )}

              {/* The PRD asks for feedback that explains rather than scoring (§9). */}
              {result.grade && (
                <div className="card" style={{ background: 'var(--bg-page)', border: '1px solid var(--border-light)' }}>
                  <p style={{ marginBottom: 'var(--space-3)' }}>{result.grade.feedback}</p>
                  {result.grade.understood.length > 0 && (
                    <div style={{ marginBottom: 'var(--space-3)' }}>
                      <strong className="ok"><Icon name="check-circle" size={15} /> You covered</strong>
                      <ul className="bullets">
                        {result.grade.understood.map((u, i) => <li key={i}>{u}</li>)}
                      </ul>
                    </div>
                  )}
                  {result.grade.missing.length > 0 && (
                    <div>
                      <strong className="warn"><Icon name="alert" size={15} /> Missing</strong>
                      <ul className="bullets">
                        {result.grade.missing.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {result.mastery && (
                <div style={{
                  padding: 'var(--space-3)',
                  background: 'var(--lavender-50)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                }}>
                  <Icon name="chart-bar" size={15} /> Mastery for this concept: {Math.round(result.mastery.before * 100)}% →{' '}
                  <strong>{Math.round(result.mastery.after * 100)}%</strong>
                  {result.mastery.delta >= 0 ? ' ▲' : ' ▼'}
                </div>
              )}

              <button onClick={next} disabled={!nextQuestion}>
                {loadingNext
                  ? 'Preparing the next question…'
                  : nextQuestion
                    ? `→ Next question (${result.progress.answered + 1} of ${result.progress.target})`
                    : 'Finishing…'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
