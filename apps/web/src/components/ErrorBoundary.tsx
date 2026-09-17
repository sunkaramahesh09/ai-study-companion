import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render-time crash so one broken panel does not blank the app.
 *
 * Without this, React 19 unmounts the whole tree on an uncaught render error
 * and the user gets a white page with nothing to click — indistinguishable
 * from the app failing to load at all. The most likely trigger here is real:
 * an API shape that changed under a deployed frontend, which is exactly what
 * happens between a backend deploy and a frontend deploy.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallbackTitle?: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console rather than sent anywhere: there is no error
    // reporting service in this build, and pretending otherwise would be worse
    // than saying so.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="card fade-in" style={{ maxWidth: 600, margin: 'var(--space-8) auto', padding: 'var(--space-8)', textAlign: 'center' }}>
        <span style={{ fontSize: 48, display: 'block', marginBottom: 'var(--space-4)' }}>💥</span>
        <h3>{this.props.fallbackTitle ?? 'Something went wrong on this page'}</h3>
        <p className="muted" style={{ marginBottom: 'var(--space-4)' }}>
          The rest of the app still works. Reloading usually clears this — if it does not, the page may
          be out of date with the server.
        </p>
        <div style={{
          background: 'var(--error-50)',
          color: 'var(--error-600)',
          padding: 'var(--space-4)',
          borderRadius: 'var(--radius-lg)',
          textAlign: 'left',
          fontFamily: 'monospace',
          fontSize: 'var(--text-sm)',
          overflowX: 'auto',
          marginBottom: 'var(--space-6)',
          border: '1px solid var(--error-100)',
        }}>
          {this.state.error.message}
        </div>
        <div className="cta-row" style={{ justifyContent: 'center' }}>
          <button type="button" className="cta" onClick={() => window.location.reload()}>
            Reload the page
          </button>
          <button type="button" className="cta-ghost" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
