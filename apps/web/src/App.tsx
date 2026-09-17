import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider.tsx';
import { Login } from './routes/Login.tsx';
import { Home } from './routes/Home.tsx';
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: '100dvh', background: 'var(--bg-page)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-4)' }}>
          <div className="sidebar-logo-icon" style={{ width: 64, height: 64, fontSize: 32 }}>🎓</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        </div>
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
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<Home />} />
          <Route path="/spaces" element={<Spaces />} />
          <Route path="/spaces/:spaceId" element={<SpaceDetail />} />
          <Route path="/projects/:projectId" element={<ProjectDashboard />} />
          <Route path="/projects/:projectId/tutor" element={<Tutor />} />
          <Route path="/projects/:projectId/quiz" element={<Quiz />} />
          <Route path="/projects/:projectId/growth" element={<Growth />} />
          <Route path="/projects/:projectId/analytics" element={<Analytics />} />

          {/* Tutor/Quiz are per-project — there is no standalone page, so the
              sidebar's global shortcuts land on Spaces to pick a project. */}
          <Route path="/tutor" element={<Navigate to="/spaces" replace />} />
          <Route path="/quiz" element={<Navigate to="/spaces" replace />} />
          <Route path="/progress" element={<Navigate to="/analytics" replace />} />

          <Route path="/analytics" element={<GlobalAnalytics />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
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
