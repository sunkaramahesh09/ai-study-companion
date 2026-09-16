import { useEffect, useRef, useState } from 'react';
import {
  deleteMaterial,
  listMaterials,
  retryMaterial,
  uploadMaterial,
  type MaterialSummary,
} from '../lib/queries.ts';
import { EmptyState, ErrorNote, StatusPill } from './Ui.tsx';

const MAX_MB = 25;
const isPending = (m: MaterialSummary) => m.status === 'queued' || m.status === 'processing';

export function MaterialUpload({ projectId, initial }: { projectId: string; initial: MaterialSummary[] }) {
  const [materials, setMaterials] = useState<MaterialSummary[]>(initial);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Poll while anything is queued or processing.
   *
   * The PRD is explicit that the user should not need to keep the browser open
   * (§13) — the work continues regardless. Polling only exists so the page
   * reflects reality while it happens to be open, and it stops as soon as
   * nothing is pending rather than running forever.
   */
  useEffect(() => {
    if (!materials.some(isPending)) return;
    const timer = setInterval(() => {
      listMaterials(projectId)
        .then(setMaterials)
        .catch(() => {
          /* transient; the next tick retries */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [projectId, materials]);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);

    // Checked here for a fast, clear message; the server re-checks both size
    // and magic bytes, because a client-side check is a convenience, not a
    // control.
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB.`));
      return;
    }

    setProgress(0);
    try {
      const material = await uploadMaterial(projectId, file, setProgress);
      setMaterials((prev) => [material, ...prev]);
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function onRetry(id: string) {
    setError(null);
    try {
      await retryMaterial(id);
      setMaterials((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'queued', error_message: null } : m)));
    } catch (err) {
      setError(err);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteMaterial(id);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="card">
      <div className="section-head">
        <h3>Materials</h3>
        <button onClick={() => inputRef.current?.click()} disabled={progress !== null}>
          {progress !== null ? `Uploading ${progress}%` : 'Upload PDF'}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => void onPick(e.target.files?.[0])}
      />

      {progress !== null && (
        <div className="bar" aria-label={`Uploading ${progress}%`}>
          <div className="bar-fill bar-ok" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error ? <ErrorNote error={error} /> : null}

      {materials.length === 0 ? (
        <EmptyState
          title="No materials yet"
          hint={`Upload a PDF (up to ${MAX_MB} MB). Processing runs in the background — you can close this page.`}
        />
      ) : (
        <ul className="list">
          {materials.map((m) => (
            <li key={m.id}>
              <span className="clamp" title={m.filename}>{m.filename}</span>
              <span className="row-end">
                {m.status === 'ready' && m.page_count != null && (
                  <span className="muted small">{m.page_count}p · {m.chunk_count} chunks</span>
                )}
                {m.status === 'failed' && m.error_message && (
                  <span className="error small clamp" title={m.error_message}>{m.error_message}</span>
                )}
                <StatusPill status={m.status} />
                {m.status === 'failed' && (
                  <button className="link" onClick={() => void onRetry(m.id)}>Retry</button>
                )}
                <button className="link" onClick={() => void onDelete(m.id)} aria-label={`Delete ${m.filename}`}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
