import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  deleteFlashcard,
  generateFlashcards,
  getFlashcards,
  reviewFlashcard,
  type Flashcard,
  type FlashcardDeck,
  type ReviewRating,
} from '../lib/queries.ts';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../components/Ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { StudyContextBar } from '../components/StudyContext.tsx';
import { relativeDue } from '../lib/relativeTime.ts';

/**
 * Flashcard review (PRD "Nice to Have": flashcards + spaced repetition).
 *
 * One card at a time, answer hidden until the learner asks for it. Showing the
 * back before they have tried to recall it turns the deck into a reading list,
 * which is the one thing a flashcard is not.
 *
 * The four ratings are the learner's own report of how the recall went; the
 * interval they produce is computed on the server by a pure function, never
 * sent from here.
 */

const RATINGS: { rating: ReviewRating; label: string; hint: string; tone: string }[] = [
  { rating: 'again', label: 'Again', hint: 'No idea — show it again shortly', tone: 'rate-again' },
  { rating: 'hard', label: 'Hard', hint: 'Got there, but it was a struggle', tone: 'rate-hard' },
  { rating: 'good', label: 'Good', hint: 'Recalled it', tone: 'rate-good' },
  { rating: 'easy', label: 'Easy', hint: 'Instant — leave it longer', tone: 'rate-easy' },
];

export function Flashcards() {
  const { projectId } = useParams<{ projectId: string }>();
  const [deck, setDeck] = useState<FlashcardDeck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<unknown>(null);
  const [revealed, setRevealed] = useState(false);
  /** What the last generation had to say — "nothing new", or which concepts failed. */
  const [genNote, setGenNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Cards reviewed in this sitting, so a card rated "again" (due in 10 minutes)
  // does not reappear immediately and make the queue look stuck.
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<{ front: string; dueAt: string } | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    getFlashcards(projectId).then(setDeck, setError);
  }, [projectId]);

  useEffect(load, [load]);

  const queue = useMemo(
    () => (deck?.due ?? []).filter((c) => !reviewed.includes(c.id)),
    [deck, reviewed],
  );
  const card: Flashcard | undefined = queue[0];

  useEffect(() => {
    setRevealed(false);
  }, [card?.id]);

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!deck) return <Spinner />;

  async function generate(count = 6) {
    if (!projectId) return;
    setGenerating(true);
    setGenError(null);
    setGenNote(null);
    try {
      const result = await generateFlashcards(projectId, count);
      setReviewed([]);
      if (result.message) {
        setGenNote(result.message);
      } else if (result.failures.length > 0) {
        // Partial success is worth saying out loud: some concepts have no
        // material behind them, and the learner is the only one who can fix that.
        setGenNote(
          `Added ${result.cards.length} card${result.cards.length === 1 ? '' : 's'}. No material covers ${result.failures
            .map((f) => f.concept)
            .join(', ')}.`,
        );
      }
      load();
    } catch (err) {
      setGenError(err);
    } finally {
      setGenerating(false);
    }
  }

  async function rate(rating: ReviewRating) {
    if (!card) return;
    setBusy(true);
    try {
      const { card: updated } = await reviewFlashcard(card.id, rating);
      setReviewed((r) => [...r, card.id]);
      setLastResult({ front: updated.front, dueAt: updated.dueAt });
      // Refresh totals in the background; the queue already moved on.
      load();
    } catch (err) {
      setGenError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteFlashcard(id);
      setReviewed((r) => [...r, id]);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fade-in">
      {projectId && <StudyContextBar projectId={projectId} mode="flashcards" />}

      <PageHeader
        icon={<Icon name="cards" size={26} />}
        title="Flashcards"
        description={`${deck.project.name} — cards written from your own material, scheduled by how well you recall them.`}
        action={
          <button
            type="button"
            className="cta"
            onClick={() => generate()}
            disabled={generating || busy}
          >
            <Icon name="plus" size={15} />
            {generating ? 'Writing cards…' : deck.totals.cards === 0 ? 'Generate a deck' : 'Add more cards'}
          </button>
        }
      />

      {genError ? <ErrorNote error={genError} /> : null}
      {genNote && (
        <p className="muted small" style={{ marginTop: 'var(--space-2)' }}>
          {genNote}
        </p>
      )}

      <div className="stats stagger">
        <div className="stat">
          <span className="stat-n">{deck.totals.cards}</span>
          <span className="muted small">cards</span>
        </div>
        <div className="stat">
          <span className="stat-n">{queue.length}</span>
          <span className="muted small">due now</span>
        </div>
        <div className="stat">
          <span className="stat-n">{deck.totals.learned}</span>
          <span className="muted small">reviewed at least once</span>
        </div>
      </div>

      {generating && <Spinner label="Writing cards from your material…" />}

      {deck.totals.cards === 0 && !generating ? (
        <EmptyState
          icon={<Icon name="cards" size={26} />}
          title="No cards yet"
          hint="Cards are written from the material you uploaded, for the concepts your quizzes say are weakest. Generating a deck takes a few seconds per concept."
          action={
            <button type="button" className="cta" onClick={() => generate()} disabled={generating}>
              Generate a deck
            </button>
          }
        />
      ) : card ? (
        <div className="card flashcard">
          <div className="flashcard-meta">
            {card.conceptName && (
              <span className="pill">
                <Icon name="brain" size={13} /> {card.conceptName}
              </span>
            )}
            {card.lapses > 0 && (
              <span className="muted small">
                forgotten {card.lapses} time{card.lapses === 1 ? '' : 's'}
              </span>
            )}
            <span className="muted small">{queue.length} left in this queue</span>
          </div>

          <p className="flashcard-front">{card.front}</p>

          {!revealed ? (
            <>
              {card.hint && <p className="muted small flashcard-hint">Hint: {card.hint}</p>}
              <div className="cta-row">
                <button type="button" className="cta" onClick={() => setRevealed(true)}>
                  Show answer
                </button>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => remove(card.id)}
                  disabled={busy}
                >
                  Delete this card
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="flashcard-back">{card.back}</p>
              <p className="muted small">How did that go?</p>
              <div className="rating-row">
                {RATINGS.map((r) => (
                  <button
                    key={r.rating}
                    type="button"
                    className={`rating ${r.tone}`}
                    onClick={() => rate(r.rating)}
                    disabled={busy}
                    title={r.hint}
                  >
                    <strong>{r.label}</strong>
                    <span className="muted small">{r.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<Icon name="check-circle" size={26} />}
          title="Nothing due right now"
          hint={
            deck.nextDueAt
              ? `The next card is due ${relativeDue(deck.nextDueAt)}. Spacing the reviews out is the point — coming back later is what makes them stick.`
              : 'Every card in this deck is scheduled. Add more cards, or come back when they are due.'
          }
          action={
            <button type="button" className="cta" onClick={() => generate()} disabled={generating}>
              Add more cards
            </button>
          }
        />
      )}

      {lastResult && (
        <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
          Last card scheduled: <strong>{lastResult.front.slice(0, 60)}</strong> — back{' '}
          {relativeDue(lastResult.dueAt)}.
        </p>
      )}

      {deck.cards.length > 0 && (
        <div className="card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-head">
            <h3>The whole deck</h3>
            <span className="muted small">{deck.cards.length} cards</span>
          </div>
          <ul className="deck-list">
            {deck.cards.map((c) => (
              <li key={c.id}>
                <span className="clamp">{c.front}</span>
                <span className="muted small">
                  {c.conceptName ? `${c.conceptName} · ` : ''}due {relativeDue(c.dueAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
