import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider.tsx';
import { Login } from './routes/Login.tsx';
import { Spaces } from './routes/Spaces.tsx';
import { SpaceDetail } from './routes/SpaceDetail.tsx';
import { ProjectDashboard } from './routes/ProjectDashboard.tsx';
import { Tutor } from './routes/Tutor.tsx';
import { Shell } from './components/Shell.tsx';
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

  if (!session) return <Login />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Spaces />} />
        <Route path="/spaces/:spaceId" element={<SpaceDetail />} />
        <Route path="/projects/:projectId" element={<ProjectDashboard />} />
        <Route path="/projects/:projectId/tutor" element={<Tutor />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
