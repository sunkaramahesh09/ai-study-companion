import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="app-shell">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main-content">
        {/*
          There is no topbar. It held only a hamburger and a copy of the user
          block the sidebar footer already shows, so on desktop it was an empty
          strip costing 64px of vertical space on every page. The hamburger
          still has to exist below 768px, where the sidebar is off-canvas, so it
          survives as a floating control rather than as a reason to keep a bar.
        */}
        <button
          type="button"
          className="mobile-menu-btn"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle navigation menu"
          aria-expanded={sidebarOpen}
        >
          ☰
        </button>
        {/* Keyed on the path so React remounts on navigation and the
            pageEnter animation replays — otherwise it would run once on first
            load and never again. */}
        <main key={location.pathname}>{children}</main>
      </div>
    </div>
  );
}
