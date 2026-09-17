import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { askTutor, getMessages, type TutorMessage } from '../lib/queries.ts';
import { ErrorNote } from '../components/Ui.tsx';

export function Tutor() {
  const { projectId } = useParams<{ projectId: string }>();
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (conversationId) getMessages(conversationId).then(setMessages).catch(() => {});
  }, [conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  async function onAsk(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || !projectId || busy) return;

    setError(null);
    setBusy(true);
    setQuestion('');

    // Show the learner's turn immediately. The answer takes a couple of
    // seconds, and an empty screen in the meantime reads as a broken app.
    const optimistic: TutorMessage = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: q,
      citations: [],
      grounded: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await askTutor(projectId, q, conversationId);
      setConversationId(res.conversationId);
      setMessages((prev) => [...prev, res.message]);
    } catch (err) {
      setError(err);
      // Put the question back so it is not lost to a failed request.
      setQuestion(q);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tutor">
      <Link to={`/projects/${projectId}`} className="back">← Back to Project</Link>
      <div className="section-head">
        <div>
          <h2>Tutor</h2>
          <p className="muted">Answers come from your uploaded material, with the page they came from.</p>
        </div>
      </div>

      <div className="chat card">
        {messages.length === 0 && !busy && (
          <p className="muted">
            Ask anything about your material. If it isn't covered, I'll say so rather than guess.
          </p>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`turn turn-${m.role}`}>
            <div className="turn-body">{m.content}</div>

            {m.role === 'assistant' && m.citations.length > 0 && (
              <div className="citations">
                {m.citations.map((c) => (
                  <details key={c.chunkId} className="citation">
                    <summary>
                      <span className="cite-tag">S{c.sourceId}</span>
                      {c.filename} — Page {c.pageNumber}
                    </summary>
                    <p className="muted small">{c.snippet}</p>
                  </details>
                ))}
              </div>
            )}

            {/* A refusal is a correct outcome, so it is labelled as such rather
                than styled like an error. */}
            {m.role === 'assistant' && m.grounded === false && (
              <span className="pill pill-queued">no supporting evidence found</span>
            )}
          </div>
        ))}

        {busy && <div className="turn turn-assistant"><span className="muted">Reading your material…</span></div>}
        <div ref={endRef} />
      </div>

      {error ? <ErrorNote error={error} /> : null}

      <form className="ask" onSubmit={onAsk}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about your material…"
          maxLength={2000}
          disabled={busy}
        />
        <button type="submit" disabled={busy || question.trim().length < 3}>
          {busy ? 'Thinking…' : 'Ask'}
        </button>
      </form>
    </section>
  );
}
