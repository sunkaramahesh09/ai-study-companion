import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Topbar } from './Topbar.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main-content">
        <Topbar onMenuClick={() => setSidebarOpen((v) => !v)} />
        <main>{children}</main>
      </div>
    </div>
  );
}
