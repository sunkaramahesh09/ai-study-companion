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
      <div className="card">
        <h3>{this.props.fallbackTitle ?? 'Something went wrong on this page'}</h3>
        <p className="muted">
          The rest of the app still works. Reloading usually clears this — if it does not, the page may
          be out of date with the server.
        </p>
        <p className="error small mono">{this.state.error.message}</p>
        <div className="cta-row">
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
