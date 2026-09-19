import { useEffect, useRef, useState } from 'react';
import {
  deleteMaterial,
  listMaterials,
  retryMaterial,
  uploadMaterial,
  type MaterialSummary,
} from '../lib/queries.ts';
import { EmptyState, ErrorNote, FileTypeIcon, StatusPill } from './Ui.tsx';
import { Icon } from './Icon.tsx';

const MAX_MB = 25;
const isPending = (m: MaterialSummary) => m.status === 'queued' || m.status === 'processing';

export function MaterialUpload({ projectId, initial }: { projectId: string; initial: MaterialSummary[] }) {
  const [materials, setMaterials] = useState<MaterialSummary[]>(initial);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
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
      setDrag(false);
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
    if (!window.confirm('Delete this material?')) return;
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
      <div className="card-head">
        <h3>Materials</h3>
        <span className="muted small">{materials.length} uploaded</span>
      </div>

      <div
        className={`upload-zone ${drag ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (progress === null) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          if (progress !== null) return;
          void onPick(e.dataTransfer.files?.[0]);
        }}
        onClick={() => progress === null && inputRef.current?.click()}
      >
        <div className="upload-icon"><Icon name="upload" size={28} /></div>
        <strong style={{ display: 'block', fontSize: 'var(--text-md)' }}>
          {progress !== null ? `Uploading… ${progress}%` : 'Drop a PDF here or click to browse'}
        </strong>
        <p className="muted small" style={{ marginTop: 'var(--space-1)' }}>PDF only, up to {MAX_MB} MB</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
      </div>

      {progress !== null && (
        <div className="bar" aria-label={`Uploading ${progress}%`} style={{ marginTop: 'var(--space-3)' }}>
          <div className="bar-fill bar-ok" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error ? <div style={{ marginTop: 'var(--space-3)' }}><ErrorNote error={error} /></div> : null}

      {materials.length === 0 ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <EmptyState
            icon={<Icon name="folder" size={26} />}
            title="No materials yet"
            hint={`Upload a PDF (up to ${MAX_MB} MB). Processing runs in the background — you can close this page.`}
          />
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-4)' }}>
          {materials.map((m) => (
            <div key={m.id} className="material-row fade-in">
              <FileTypeIcon filename={m.filename} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="clamp" style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }} title={m.filename}>
                  {m.filename}
                </div>
                <div className="muted small">
                  {m.status === 'ready' && m.page_count != null
                    ? `${m.page_count}p · ${m.chunk_count} chunks`
                    : m.status === 'failed' && m.error_message
                      ? <span className="error" title={m.error_message}>{m.error_message}</span>
                      : null}
                </div>
              </div>
              <StatusPill status={m.status} />
              {/* Offered on `ready` too, not just `failed`. Extraction and
                  concept generation are two jobs: the text can index while
                  concept extraction fails, leaving a green "ready" row and a
                  project with no concepts, so no quiz and no mastery — with
                  nothing on this screen to press. The API has always accepted a
                  retry for anything not mid-processing; only this button was
                  narrower than the endpoint behind it (D-088). */}
              {m.status !== 'processing' && m.status !== 'queued' && (
                <button
                  className="btn-icon"
                  onClick={() => void onRetry(m.id)}
                  title={m.status === 'failed' ? 'Retry' : 'Reprocess this document'}
                  aria-label={`${m.status === 'failed' ? 'Retry' : 'Reprocess'} ${m.filename}`}
                >
                  <Icon name="refresh" size={15} />
                </button>
              )}
              <button
                className="btn-icon"
                onClick={() => void onDelete(m.id)}
                title="Delete"
                aria-label={`Delete ${m.filename}`}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
