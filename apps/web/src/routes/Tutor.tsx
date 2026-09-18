import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { askTutor, getMessages, touchProject, type TutorMessage } from '../lib/queries.ts';
import { ErrorNote, PageHeader } from '../components/Ui.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { StudyContextBar } from '../components/StudyContext.tsx';

export function Tutor() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  // Prefilled from ?q= when the learner arrives from a recommendation, so the
  // card's action lands on a question ready to send rather than an empty box.
  // Deliberately not auto-sent: navigating should never spend quota on the
  // learner's behalf, and they may want to reword it first.
  const [question, setQuestion] = useState(() => searchParams.get('q') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (conversationId) getMessages(conversationId).then(setMessages).catch(() => {});
  }, [conversationId]);

  // Asking the Tutor is using the project, so it moves `last_active_at` — that
  // is what "continue where you left off" reads (D-065).
  useEffect(() => {
    if (projectId) void touchProject(projectId).catch(() => {});
  }, [projectId]);

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

  async function onCopy(id: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      // Clipboard permission denied — nothing to recover, just no feedback.
    }
  }

  const quickActions: { icon: IconName; label: string }[] = [
    { icon: 'bulb', label: 'Explain simply' },
    { icon: 'note', label: 'Give an example' },
    { icon: 'quiz', label: 'Quiz me on this' },
    { icon: 'book', label: 'Help me revise' },
  ];

  return (
    <section className="tutor-page fade-in">
      {projectId && <StudyContextBar projectId={projectId} mode="tutor" />}

      <PageHeader
        icon={<Icon name="tutor" size={26} />}
        title="AI Tutor"
        description="Answers come from your uploaded material, with the page they came from."
      />

      {/* Chat Area */}
      <div className="chat">
        {messages.length === 0 && !busy && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 'var(--space-4)', padding: 'var(--space-8)' }}>
            <div style={{ fontSize: 48, marginBottom: 'var(--space-2)' }}><Icon name="cap" size={16} /></div>
            <h3 style={{ textAlign: 'center' }}>Ask Your AI Tutor</h3>
            <p className="muted" style={{ textAlign: 'center', maxWidth: 420 }}>
              Ask anything about your material. If it isn't covered, I'll say so rather than guess.
            </p>
            <div className="quick-actions" style={{ justifyContent: 'center' }}>
              {quickActions.map((qa) => (
                <button
                  key={qa.label}
                  className="quick-action"
                  onClick={() => setQuestion(qa.label)}
                >
                  <Icon name={qa.icon} size={15} /> {qa.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`turn turn-${m.role}`}>
            <div className={`turn-avatar ${m.role === 'assistant' ? 'turn-avatar-ai' : 'turn-avatar-user'}`}>
              <Icon name={m.role === 'assistant' ? 'cap' : 'user'} size={16} />
            </div>
            <div className="turn-content">
              {m.role === 'assistant' && m.citations.length > 0 && (
                <div className="turn-grounded-badge">
                  <Icon name="book" size={15} /> Based on your materials
                </div>
              )}
              <div className="turn-body">{m.content}</div>

              {m.role === 'assistant' && m.citations.length > 0 && (
                <div className="citations">
                  {m.citations.map((c) => (
                    <details key={c.chunkId} className="citation">
                      <summary>
                        <span className="cite-tag">S{c.sourceId}</span>
                        <span style={{ fontSize: 14 }}><Icon name="file" size={16} /></span>
                        <span>{c.filename} — Page {c.pageNumber}</span>
                      </summary>
                      <p className="muted small">{c.snippet}</p>
                    </details>
                  ))}
                </div>
              )}

              {/* A refusal is a correct outcome, so it is labelled as such
                  rather than styled like an error. */}
              {m.role === 'assistant' && m.grounded === false && (
                <span className="pill pill-queued"><Icon name="alert" size={15} /> No supporting evidence found</span>
              )}

              {m.role === 'assistant' && (
                <div className="turn-actions">
                  <button
                    className="turn-action-btn"
                    title="Copy"
                    aria-label="Copy response"
                    onClick={() => void onCopy(m.id, m.content)}
                  >
                    <Icon name={copiedId === m.id ? 'check' : 'clipboard'} size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="turn turn-assistant">
            <div className="turn-avatar turn-avatar-ai"><Icon name="cap" size={16} /></div>
            <div className="turn-content">
              <div className="turn-body" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="muted" style={{ marginLeft: 'var(--space-2)' }}>Reading your material…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error ? <ErrorNote error={error} /> : null}

      {/* Composer */}
      <div className="ask">
        <form onSubmit={onAsk}>
          <div className="ask-input-row">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about your material…"
              maxLength={2000}
              disabled={busy}
            />
            <button type="submit" className="ask-send" disabled={busy || question.trim().length < 3}>
              <Icon name={busy ? 'clock' : 'arrow-right'} size={15} /> {busy ? 'Thinking…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
