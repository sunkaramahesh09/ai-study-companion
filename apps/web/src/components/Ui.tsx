import type { ReactNode } from 'react';

/** Loading spinner with animated dots */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'var(--space-8)', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', gap: '6px' }}>
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
      <p className="muted small">{label}</p>
    </div>
  );
}

/** Loading skeleton for cards */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card" style={{ padding: 'var(--space-6)' }}>
          <div className="skeleton skeleton-title" style={{ width: '60%' }} />
          <div className="skeleton skeleton-text" style={{ width: '90%', marginTop: 'var(--space-3)' }} />
          <div className="skeleton skeleton-text" style={{ width: '40%' }} />
        </div>
      ))}
    </div>
  );
}

/** Error display with optional retry */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div style={{
      padding: 'var(--space-4)',
      background: 'var(--error-50)',
      border: '1px solid var(--error-100)',
      borderRadius: 'var(--radius-lg)',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
    }}>
      <span style={{ fontSize: '20px' }}>⚠️</span>
      <div style={{ flex: 1 }}>
        <p className="error" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{message}</p>
      </div>
      {onRetry && (
        <button className="btn-secondary" style={{ padding: '6px 14px', fontSize: 'var(--text-sm)' }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Empty states carry the next action rather than just saying "nothing here".
 * The PRD's home dashboard has to answer "what should I do next?" (§16), and an
 * empty project is exactly when that question is most acute.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty fade-in">
      {icon && <span className="empty-icon">{icon}</span>}
      <strong style={{ fontSize: 'var(--text-md)' }}>{title}</strong>
      <p className="muted">{hint}</p>
      {action && <div style={{ marginTop: 'var(--space-2)' }}>{action}</div>}
    </div>
  );
}

/**
 * Mastery progress bar with animated fill.
 * Mastery is an estimate, not a measurement (PRD §10) — the tone stays
 * informative rather than a pass/fail judgement.
 */
export function MasteryBar({ score, size = 'normal' }: { score: number; size?: 'small' | 'normal' }) {
  const pct = Math.round(score * 100);
  const tone = pct >= 75 ? 'ok' : pct >= 50 ? 'warn' : 'low';
  return (
    <div
      className="bar"
      role="img"
      aria-label={`${pct}% mastery`}
      style={{ height: size === 'small' ? '6px' : '8px' }}
    >
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Status pill badge */
export function StatusPill({ status }: { status: string }) {
  const icons: Record<string, string> = {
    ready: '✅',
    processing: '⏳',
    queued: '⏳',
    failed: '❌',
  };
  return (
    <span className={`pill pill-${status}`}>
      {icons[status] && <span>{icons[status]}</span>}
      {status}
    </span>
  );
}

/** SVG Progress Ring (donut chart) */
export function ProgressRing({
  value,
  size = 120,
  strokeWidth = 10,
  label,
  color,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value);

  return (
    <div className="progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          className="progress-ring-bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className="progress-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            stroke: color || 'var(--primary-500)',
            '--circumference': circumference,
            '--dash-offset': offset,
          } as React.CSSProperties}
        />
      </svg>
      <div className="progress-ring-text">
        <span className="progress-ring-value">{Math.round(value * 100)}%</span>
        {label && <span className="progress-ring-label">{label}</span>}
      </div>
    </div>
  );
}

/** User avatar circle */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initial = name?.charAt(0).toUpperCase() || 'U';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--primary-400)',
        color: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: size * 0.4,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

/** File type icon */
export function FileTypeIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, { cls: string; label: string }> = {
    pdf: { cls: 'file-icon-pdf', label: 'PDF' },
  };
  const t = types[ext] ?? { cls: 'file-icon-txt', label: ext.toUpperCase().slice(0, 3) || 'FILE' };
  return <div className={`file-icon ${t.cls}`}>{t.label}</div>;
}

/** Stat card for dashboards */
export function StatCard({
  icon,
  iconBg,
  value,
  label,
  change,
}: {
  icon: string;
  iconBg: string;
  value: string | number;
  label: string;
  change?: string;
}) {
  return (
    <div className="home-stat-card hover-lift">
      <div className="home-stat-icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <div>
        <div className="home-stat-value">{value}</div>
        <div className="home-stat-label">{label}</div>
        {change && <div className="home-stat-change">↑ {change}</div>}
      </div>
    </div>
  );
}

/** Page header with title, description, and optional action */
export function PageHeader({
  icon,
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        {icon && (
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 'var(--radius-lg)',
            background: 'var(--lavender-100)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}>
            {icon}
          </div>
        )}
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
