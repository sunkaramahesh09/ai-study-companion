import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api } from '../lib/api.ts';

type MeResponse = { user: { id: string; email: string; role: 'user' | 'admin' } };

export function Dashboard() {
  const { profile, signOut } = useAuth();
  const [apiStatus, setApiStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    // Proves the full chain end to end: browser session -> bearer token ->
    // Fastify auth plugin -> RLS-scoped profile read -> response.
    api<MeResponse>('/api/me')
      .then(() => setApiStatus('ok'))
      .catch((err: unknown) => {
        setApiStatus('error');
        setApiError(err instanceof Error ? err.message : 'Unknown error');
      });
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <strong>AI Study Companion</strong>
        <div className="topbar-right">
          <span className="muted">{profile?.email}</span>
          {profile?.role === 'admin' && <span className="badge">admin</span>}
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="card">
        <h2>You're signed in</h2>
        <p className="muted">
          Authentication, RLS-scoped data access and the admin gate are working. Spaces and
          Projects land next.
        </p>
        <p>
          Backend session check:{' '}
          {apiStatus === 'checking' && <span className="muted">checking…</span>}
          {apiStatus === 'ok' && <span className="ok">authenticated</span>}
          {apiStatus === 'error' && <span className="error">failed — {apiError}</span>}
        </p>
      </main>
    </div>
  );
}
