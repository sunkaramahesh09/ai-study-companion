import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.tsx';
import { listSpaces } from '../lib/queries.ts';
import type { Space } from '@asc/shared';
import { Icon, type IconName } from './Icon.tsx';
import { ConfirmDialog } from './Ui.tsx';

const SPACE_COLORS = [
  '#6c47ec', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4',
];

// Tutor/Quiz are per-project. These land on a launcher that leads with the last
// space and project used, so continuing is one click rather than a walk back
// down the hierarchy (D-065).
const NAV_ITEMS: { path: string; icon: IconName; label: string }[] = [
  { path: '/home', icon: 'home', label: 'Home' },
  { path: '/tutor', icon: 'tutor', label: 'Ask Tutor' },
  { path: '/quiz', icon: 'quiz', label: 'Quizzes' },
  { path: '/progress', icon: 'progress', label: 'Progress' },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<Space[]>([]);
  // Signing out is one click away from everything else in this rail, and the
  // way back is a full sign-in. Worth a question first.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    listSpaces().then(setSpaces).catch(() => {});
  }, []);

  const isActive = (path: string) => {
    if (path === '/home') return location.pathname === '/home' || location.pathname === '/';
    // `/projects/<id>/quiz` IS the Quizzes section — highlighting only the
    // launcher would leave the nav blank for the whole time a quiz is running.
    if (path === '/quiz' || path === '/tutor') {
      return location.pathname === path || location.pathname.endsWith(path);
    }
    return location.pathname.startsWith(path);
  };

  // The name the learner gave at sign-up, which the profile row has had all
  // along — the sidebar was just never reading it, so it showed the email's
  // local part in the name slot and the same address again underneath, and the
  // block read as the email twice (D-068). The local part stays as the
  // fallback for a profile created before the name field existed.
  const userName = profile?.fullName?.trim() || profile?.email?.split('@')[0] || 'Student';
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <>
      <div className={`sidebar-overlay${open ? ' visible' : ''}`} onClick={onClose} />
      <aside className={`sidebar${open ? ' open' : ''}`}>
        {/* Logo */}
        <Link to="/home" className="sidebar-logo" onClick={onClose}>
          <div className="sidebar-logo-icon"><Icon name="cap" size={20} /></div>
          <div className="sidebar-logo-text">
            <h1>AI.Prof</h1>
            <span>Your AI Study Companion</span>
          </div>
        </Link>

        {/* Main Navigation */}
        <nav className="sidebar-nav">
          <div>
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={`sidebar-link${isActive(item.path) ? ' active' : ''}`}
                onClick={onClose}
              >
                <span className="sidebar-link-icon"><Icon name={item.icon} /></span>
                <span>{item.label}</span>
              </Link>
            ))}
          </div>

          {/* Study Spaces */}
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <span>Study Spaces</span>
              <Link to="/spaces" onClick={onClose} title="View all spaces">
                <button type="button" aria-label="Add space"><Icon name="plus" size={16} /></button>
              </Link>
            </div>
            {spaces.slice(0, 6).map((space, i) => (
              <Link
                key={space.id}
                to={`/spaces/${space.id}`}
                className={`sidebar-space-link${location.pathname === `/spaces/${space.id}` ? ' active' : ''}`}
                onClick={onClose}
              >
                <span
                  className="space-dot"
                  style={{ background: SPACE_COLORS[i % SPACE_COLORS.length] }}
                />
                <span className="clamp">{space.name}</span>
              </Link>
            ))}
            <Link to="/spaces" className="sidebar-add-link" onClick={onClose}>
              <Icon name="plus" size={16} />
              <span>Add Space</span>
            </Link>
          </div>
        </nav>

        {/* Pale range at the foot of the sidebar, continuing the page's own
            mountains across the divider so the two surfaces read as one
            landscape. Decorative only. */}
        <div className="sidebar-decor" aria-hidden="true">
          <i />
          <i />
        </div>

        {/* Bottom */}
        <div className="sidebar-bottom">
          <Link
            to="/admin"
            className={`sidebar-link${location.pathname === '/admin' ? ' active' : ''}`}
            onClick={onClose}
            style={{ display: profile?.role === 'admin' ? 'flex' : 'none' }}
          >
            <span className="sidebar-link-icon"><Icon name="settings" /></span>
            <span>Admin</span>
          </Link>

          <div className="sidebar-user">
            <div className="sidebar-user-avatar">{userInitial}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name" title={userName}>{userName}</div>
              {/* Truncated to the rail's width, so the full address lives in
                  the tooltip rather than being lost. */}
              <div className="sidebar-user-email" title={profile?.email}>{profile?.email}</div>
            </div>
            <button
              type="button"
              className="sidebar-signout"
              onClick={() => setConfirmingSignOut(true)}
              title="Sign out"
              aria-label="Sign out"
            >
              ↗
            </button>
          </div>
        </div>
      </aside>

      {confirmingSignOut && (
        <ConfirmDialog
          title="Sign out?"
          body={
            <>
              You'll need to sign in again to reach your spaces. Nothing is
              deleted — your projects, materials and progress are waiting when
              you come back.
            </>
          }
          confirmLabel="Sign out"
          cancelLabel="Stay signed in"
          busy={signingOut}
          onCancel={() => setConfirmingSignOut(false)}
          onConfirm={async () => {
            setSigningOut(true);
            try {
              // Leave the gated route BEFORE the session goes. Signing out on
              // /admin used to leave the browser parked there, so signing back
              // in as anyone without the role landed straight on
              // "Administrator access required" — correct, and baffling
              // (D-074). Replace rather than push: the signed-out route has no
              // business in the back history.
              navigate('/home', { replace: true });
              await signOut();
            } finally {
              // The auth state change unmounts this, but if sign-out fails the
              // dialog must not be left stuck on "Working…".
              setSigningOut(false);
              setConfirmingSignOut(false);
            }
          }}
        />
      )}
    </>
  );
}
