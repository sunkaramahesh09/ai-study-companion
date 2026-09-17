import { useAuth } from '../auth/AuthProvider.tsx';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { profile } = useAuth();
  const userInitial = profile?.email?.charAt(0).toUpperCase() ?? 'S';
  const userName = profile?.email?.split('@')[0] ?? 'Student';

  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <button
          type="button"
          className="mobile-menu-btn"
          onClick={onMenuClick}
          aria-label="Toggle menu"
        >
          ☰
        </button>
      </div>

      <div className="topbar-right">
        <div className="topbar-user">
          <div className="topbar-avatar">{userInitial}</div>
          <span className="topbar-username">{userName}</span>
        </div>
      </div>
    </header>
  );
}
