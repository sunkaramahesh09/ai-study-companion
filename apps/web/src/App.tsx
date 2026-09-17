import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider.tsx';
import { Login } from './routes/Login.tsx';
import { Spaces } from './routes/Spaces.tsx';
import { SpaceDetail } from './routes/SpaceDetail.tsx';
import { ProjectDashboard } from './routes/ProjectDashboard.tsx';
import { Tutor } from './routes/Tutor.tsx';
import { Quiz } from './routes/Quiz.tsx';
import { Growth } from './routes/Growth.tsx';
import { Analytics } from './routes/Analytics.tsx';
import { GlobalAnalytics } from './routes/GlobalAnalytics.tsx';
import { Admin } from './routes/Admin.tsx';
import { Shell } from './components/Shell.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';

function Gate() {
  const { session, loading } = useAuth();
  const location = useLocation();

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
      {/* Keyed on the ROUTER's pathname, so navigating away from a crashed
          page clears the boundary without a reload. `window.location` would
          not do — it does not change identity on a client-side navigation, so
          the boundary would stay latched for the rest of the session. */}
      <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="/" element={<Spaces />} />
          <Route path="/spaces/:spaceId" element={<SpaceDetail />} />
          <Route path="/projects/:projectId" element={<ProjectDashboard />} />
          <Route path="/projects/:projectId/tutor" element={<Tutor />} />
          <Route path="/projects/:projectId/quiz" element={<Quiz />} />
          <Route path="/projects/:projectId/growth" element={<Growth />} />
          <Route path="/projects/:projectId/analytics" element={<Analytics />} />
          <Route path="/analytics" element={<GlobalAnalytics />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
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
