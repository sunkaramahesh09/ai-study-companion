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
import { ErrorNote, Spinner } from '../components/Ui.tsx';

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
      <section>
        <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>
        <div className="card">
          <h2>Can't start a quiz yet</h2>
          <ErrorNote error={error} />
          <p className="muted">
            A quiz needs concepts, which come from processed material. Upload a PDF and wait for it to
            finish processing.
          </p>
        </div>
      </section>
    );
  }

  if (finished) {
    return (
      <section>
        <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>
        <div className="card">
          <h2>Quiz complete</h2>
          <p className="stat-n">{Math.round(finished.score * 100)}%</p>
          <p className="muted">{finished.answered} questions answered.</p>
          <p className="muted small">
            Your mastery estimates are updating now, and a recommendation is being prepared in the
            background — you don't need to wait here.
          </p>
          <div className="row-end" style={{ marginTop: 12 }}>
            <Link to={`/projects/${projectId}/growth`} className="cta">See your growth</Link>
          </div>
        </div>
      </section>
    );
  }

  const canSubmit =
    question?.question_type === 'mcq' ? selected !== null : text.trim().length >= 10;

  return (
    <section>
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>

      {question && (
        <div className="card stack">
          {resumed && (
            <p className="muted small">
              Continuing your quiz already in progress.{' '}
              <button type="button" className="link" onClick={startOver} disabled={restarting}>
                {restarting ? 'Starting over…' : 'Start a new quiz instead'}
              </button>
            </p>
          )}
          <div className="section-head" style={{ margin: 0 }}>
            <div>
              <span className="muted small">
                {question.conceptName ?? 'Concept'} · difficulty {question.difficulty}/5 ·{' '}
                {question.question_type === 'open' ? 'written answer' : 'multiple choice'}
              </span>
              <h2 style={{ marginTop: 6 }}>{question.prompt}</h2>
            </div>
          </div>

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
                {busy ? 'Checking…' : 'Submit answer'}
              </button>
            </form>
          )}

          {error ? <ErrorNote error={error} /> : null}

          {result && (
            <div className="stack">
              <div className={result.isCorrect ? 'verdict verdict-ok' : 'verdict verdict-no'}>
                {result.questionType === 'open'
                  ? `Scored ${Math.round(result.score * 100)}%`
                  : result.isCorrect
                    ? 'Correct'
                    : 'Not quite'}
              </div>

              {result.questionType === 'mcq' && result.correctIndex !== undefined && (
                <p>
                  <strong>Answer:</strong> {(question.options ?? [])[result.correctIndex]}
                  {result.explanation ? <><br /><span className="muted">{result.explanation}</span></> : null}
                </p>
              )}

              {/* The PRD asks for feedback that explains rather than scoring (§9). */}
              {result.grade && (
                <div className="stack">
                  <p>{result.grade.feedback}</p>
                  {result.grade.understood.length > 0 && (
                    <div>
                      <strong className="ok">You covered</strong>
                      <ul className="bullets">
                        {result.grade.understood.map((u, i) => <li key={i}>{u}</li>)}
                      </ul>
                    </div>
                  )}
                  {result.grade.missing.length > 0 && (
                    <div>
                      <strong className="warn">Missing</strong>
                      <ul className="bullets">
                        {result.grade.missing.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {result.mastery && (
                <p className="muted small">
                  Mastery for this concept: {Math.round(result.mastery.before * 100)}% →{' '}
                  {Math.round(result.mastery.after * 100)}%
                  {result.mastery.delta >= 0 ? ' ▲' : ' ▼'}
                </p>
              )}

              <button onClick={next} disabled={!nextQuestion}>
                {loadingNext
                  ? 'Preparing the next question…'
                  : nextQuestion
                  ? `Next question (${result.progress.answered + 1} of ${result.progress.target})`
                  : 'Finishing…'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
