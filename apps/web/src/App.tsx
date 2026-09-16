import { AuthProvider, useAuth } from './auth/AuthProvider.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Login } from './routes/Login.tsx';
import './styles.css';

function Gate() {
  const { session, loading } = useAuth();

  // Without this, a reload flashes the login screen before the persisted
  // session resolves.
  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return session ? <Dashboard /> : <Login />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
