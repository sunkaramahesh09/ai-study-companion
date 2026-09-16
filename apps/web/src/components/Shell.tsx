import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth();
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">AI Study Companion</Link>
        <div className="topbar-right">
          <span className="muted small">{profile?.email}</span>
          {profile?.role === 'admin' && <span className="badge">admin</span>}
          <button className="link" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
