import { Link } from 'react-router-dom';

/**
 * Chart primitives for the analytics views.
 *
 * Deliberately single-series. Every chart here answers one question with one
 * measure, so identity never rests on colour and no categorical palette is
 * needed — which also sidesteps the app's green/red pair sitting at deutan
 * ΔE 7.9, below the ΔE 8 separation target (D-051).
 *
 * Inline SVG rather than a charting library: these are simple shapes, and a
 * dependency would cost more bytes than the whole analytics feature.
 */

export type Bar = {
  label: string;
  value: number;
  /** Shown in the tooltip under the headline value. */
  detail?: string;
  /** Makes the row's label a link — the drill-down from a summary to its source. */
  href?: string;
};

/**
 * Daily activity. Bars, because the question is magnitude per discrete day.
 *
 * Zero days render as a baseline tick rather than nothing, so a gap reads as
 * "no activity" instead of as missing data.
 */
export function BarChart({
  bars,
  height = 96,
  formatValue = (n: number) => String(n),
  emptyLabel = 'No activity in this window.',
}: {
  bars: Bar[];
  height?: number;
  formatValue?: (n: number) => string;
  emptyLabel?: string;
}) {
  const max = Math.max(...bars.map((b) => b.value), 0);
  if (bars.length === 0 || max === 0) {
    return <p className="muted small chart-empty">{emptyLabel}</p>;
  }

  return (
    <div className="chart" style={{ height }}>
      {bars.map((b, i) => {
        const pct = (b.value / max) * 100;
        return (
          <div
            key={`${b.label}-${i}`}
            className="chart-col"
            // The tooltip is the hover layer: an SVG chart with no hover is a
            // picture of data rather than something you can interrogate.
            title={`${b.label}: ${formatValue(b.value)}${b.detail ? `\n${b.detail}` : ''}`}
          >
            <div className="chart-bar-track">
              <div
                className={b.value === 0 ? 'chart-bar chart-bar-zero' : 'chart-bar'}
                style={{ height: b.value === 0 ? '2px' : `${Math.max(pct, 4)}%` }}
                role="img"
                aria-label={`${b.label}: ${formatValue(b.value)}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Horizontal bars with the value written on each row.
 *
 * Used where there are few categories and the labels are words — a horizontal
 * layout keeps them readable without rotating text, and a direct label per row
 * removes the need to read a value off an axis.
 */
export function RowBars({
  rows,
  formatValue = (n: number) => String(n),
}: {
  rows: Bar[];
  formatValue?: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (rows.length === 0) return <p className="muted small">Nothing yet.</p>;
  return (
    <ul className="rowbars">
      {rows.map((r) => (
        <li key={r.label}>
          {r.href ? (
            <Link to={r.href} className="rowbar-label clamp rowbar-link">
              {r.label}
            </Link>
          ) : (
            <span className="rowbar-label clamp">{r.label}</span>
          )}
          <span className="rowbar-track">
            <span
              className="rowbar-fill"
              style={{ width: max > 0 ? `${Math.max((r.value / max) * 100, 2)}%` : '0%' }}
            />
          </span>
          <span className="rowbar-value muted small">{formatValue(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A single number that needs no plot.
 *
 * `null` renders as an em dash, never as 0 — "we have not measured this" and
 * "we measured zero" are different claims, and conflating them is how a new
 * account gets told it has 0% accuracy.
 */
export function Stat({
  value,
  label,
  tone,
  hint,
}: {
  value: string | number | null;
  label: string;
  tone?: 'ok' | 'error';
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <span className={tone ? `stat-n ${tone}` : 'stat-n'}>{value === null ? '—' : value}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

export const pct = (n: number | null): string | null => (n === null ? null : `${Math.round(n * 100)}%`);
