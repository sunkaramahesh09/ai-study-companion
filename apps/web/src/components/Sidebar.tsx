import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.tsx';
import { listSpaces } from '../lib/queries.ts';
import type { Space } from '@asc/shared';
import { Icon, type IconName } from './Icon.tsx';

const SPACE_COLORS = [
  '#6c47ec', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4',
];

// Tutor/Quiz are per-project — there is no standalone page for either, so
// these fall through to Spaces where the learner picks a project first.
const NAV_ITEMS: { path: string; icon: IconName; label: string }[] = [
  { path: '/home', icon: 'home', label: 'Home' },
  { path: '/tutor', icon: 'tutor', label: 'Ask Tutor' },
  { path: '/quiz', icon: 'quiz', label: 'Quizzes' },
  { path: '/progress', icon: 'progress', label: 'Progress' },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const [spaces, setSpaces] = useState<Space[]>([]);

  useEffect(() => {
    listSpaces().then(setSpaces).catch(() => {});
  }, []);

  const isActive = (path: string) => {
    if (path === '/home') return location.pathname === '/home' || location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const userInitial = profile?.email?.charAt(0).toUpperCase() ?? 'S';
  const userName = profile?.email?.split('@')[0] ?? 'Student';

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
              <div className="sidebar-user-name">{userName}</div>
              <div className="sidebar-user-email">{profile?.email}</div>
            </div>
            <button
              type="button"
              className="sidebar-signout"
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
