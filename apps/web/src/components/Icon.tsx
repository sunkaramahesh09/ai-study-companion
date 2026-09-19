import type { ReactElement, SVGProps } from 'react';

/**
 * Line icons, drawn inline rather than pulled from an icon package.
 *
 * Emoji were inconsistent by nature: each one carries its own colour, weight
 * and optical size from the system font, so a row of them never aligns and the
 * visual weight jumps between items. These share a 24px grid, a single stroke
 * width and `currentColor`, so they inherit the link's colour and its active
 * and hover states for free.
 *
 * Hand-written because the set is small. A dependency would add a package,
 * a build step and a bundle cost for six shapes, three days from a deadline.
 */

export type IconName =
  // navigation
  | 'home' | 'tutor' | 'quiz' | 'progress' | 'cap' | 'plus' | 'settings' | 'logout'
  // status
  | 'check' | 'check-circle' | 'x-circle' | 'alert' | 'clock' | 'refresh' | 'info'
  // content
  | 'file' | 'folder' | 'book' | 'note' | 'clipboard' | 'upload' | 'trash'
  // learning
  | 'bulb' | 'brain' | 'target' | 'trophy' | 'flame' | 'star' | 'sparkle' | 'cards'
  // data
  | 'chart-bar' | 'chart-line' | 'trend-up' | 'trend-down' | 'activity'
  // misc
  | 'user' | 'users' | 'lock' | 'link' | 'zap' | 'calendar' | 'flask' | 'search'
  | 'eye' | 'eye-off' | 'wave' | 'play' | 'arrow-right' | 'external' | 'menu' | 'mail' | 'rocket' | 'arrow-flat';

const PATHS: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="m3 10.2 9-7.2 9 7.2" />
      <path d="M5.2 8.9V20a1 1 0 0 0 1 1h11.6a1 1 0 0 0 1-1V8.9" />
      <path d="M9.8 21v-6.4h4.4V21" />
    </>
  ),
  tutor: (
    <path d="M20.5 11.6a8 8 0 0 1-8.6 8 8.4 8.4 0 0 1-3.6-.9L3.5 20.5l1.8-4.8a8.4 8.4 0 0 1-.9-3.6 8 8 0 0 1 8-8.6h.5a8 8 0 0 1 7.6 7.6z" />
  ),
  quiz: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="m8.4 12.2 2.6 2.6 4.9-5.3" />
    </>
  ),
  progress: (
    <>
      <path d="M3.5 3.5v17h17" />
      <path d="M8.2 16.8V11" />
      <path d="M12.8 16.8V6.8" />
      <path d="M17.4 16.8v-4" />
    </>
  ),
  cap: (
    <>
      <path d="M21.4 8.6 12 4.2 2.6 8.6 12 13z" />
      <path d="M6.6 10.7v4.2c0 1.7 2.4 3 5.4 3s5.4-1.3 5.4-3v-4.2" />
      <path d="M21.4 8.6v5.1" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.2v13.6" />
      <path d="M5.2 12h13.6" />
    </>
  ),
  settings: (
    <>
      <path d="M20 7h-8.5" />
      <path d="M14 17H4" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 20.5h4a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2h-4" />
      <path d="M9.5 16.5 14 12 9.5 7.5" />
      <path d="M14 12H3.5" />
    </>
  ),
  // ── status ──────────────────────────────────────────────────────────
  check: <path d="m4.5 12.5 5 5 10-11" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="m8.2 12.3 2.6 2.6 5-5.4" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4.2 2.7 17.4a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.6v4.2" />
      <path d="M12 17.4h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 7.2V12l3.2 1.9" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 11.4a8.5 8.5 0 1 0-.9 5" />
      <path d="M20.5 4.8v6h-6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11.2v5" />
      <path d="M12 7.9h.01" />
    </>
  ),

  // ── content ─────────────────────────────────────────────────────────
  file: (
    <>
      <path d="M14 3.2H7a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.2z" />
      <path d="M14 3.2v5h5" />
    </>
  ),
  folder: <path d="M3.5 7a2 2 0 0 1 2-2h3.4l2 2.6h7.6a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  book: (
    <>
      <path d="M4.5 5.2A2 2 0 0 1 6.5 3.2H19v15.6H6.5a2 2 0 0 0-2 2z" />
      <path d="M4.5 18.8a2 2 0 0 1 2-2H19" />
    </>
  ),
  note: (
    <>
      <path d="M16.6 3.8a2 2 0 0 1 2.8 2.8L9.8 16.2l-3.8 1 1-3.8z" />
      <path d="m14.6 5.8 2.8 2.8" />
    </>
  ),
  clipboard: (
    <>
      <rect x="7.5" y="4.4" width="9" height="3.4" rx="1.2" />
      <path d="M16.5 6.1h1.6a2 2 0 0 1 2 2v10.7a2 2 0 0 1-2 2H5.9a2 2 0 0 1-2-2V8.1a2 2 0 0 1 2-2h1.6" />
    </>
  ),
  upload: (
    <>
      <path d="M20.4 15.4v3.4a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2v-3.4" />
      <path d="m7.9 9 4.1-4.1L16.1 9" />
      <path d="M12 4.9v10.5" />
    </>
  ),
  trash: (
    <>
      <path d="M3.9 6.3h16.2" />
      <path d="M8.4 6.3V4.7a1.6 1.6 0 0 1 1.6-1.6h4a1.6 1.6 0 0 1 1.6 1.6v1.6" />
      <path d="M18 6.3v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13" />
    </>
  ),

  // ── learning ────────────────────────────────────────────────────────
  bulb: (
    <>
      <path d="M9.2 17.4a6 6 0 1 1 5.6 0" />
      <path d="M9.4 20.1h5.2" />
      <path d="M9.9 17.4h4.2" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5.2a3 3 0 0 0-5.7-1.3A2.8 2.8 0 0 0 4 8.4a3 3 0 0 0 .6 4.4A3 3 0 0 0 7 17.9a3 3 0 0 0 5 1.6z" />
      <path d="M12 5.2a3 3 0 0 1 5.7-1.3A2.8 2.8 0 0 1 20 8.4a3 3 0 0 1-.6 4.4A3 3 0 0 1 17 17.9a3 3 0 0 1-5 1.6z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="4.8" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  trophy: (
    <>
      <path d="M7.4 4.2h9.2v5a4.6 4.6 0 1 1-9.2 0z" />
      <path d="M7.4 6.1H5a1.8 1.8 0 0 0 0 3.6h2.4M16.6 6.1H19a1.8 1.8 0 0 1 0 3.6h-2.4" />
      <path d="M12 13.8v3.3M9 20.3h6M10.2 17.1h3.6l.6 3.2h-4.8z" />
    </>
  ),
  flame: (
    <>
      <path d="M12 3.2s5.6 4 5.6 9.2a5.6 5.6 0 1 1-11.2 0C6.4 7.2 12 3.2 12 3.2z" />
      <path d="M12 20a3 3 0 0 1-3-3c0-1.9 3-4.2 3-4.2s3 2.3 3 4.2a3 3 0 0 1-3 3z" />
    </>
  ),
  star: <path d="m12 3.4 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.9l6.1-.9z" />,
  sparkle: (
    <>
      <path d="M12 3.4 13.6 9 19 10.6 13.6 12.2 12 17.8 10.4 12.2 5 10.6 10.4 9z" />
      <path d="M18.2 16.4 18.8 18.4 20.8 19 18.8 19.6 18.2 21.6 17.6 19.6 15.6 19 17.6 18.4z" />
    </>
  ),

  // A stack of cards, seen slightly from the side — the front card square on,
  // two more offset behind it. Flashcards.
  cards: (
    <>
      <rect x="3.2" y="7.6" width="13.2" height="12.8" rx="2" />
      <path d="M7 5.2h9.8a2 2 0 0 1 2 2v9.4" />
      <path d="M10.4 3h7.2a2 2 0 0 1 2 2v8.4" />
    </>
  ),

  // ── data ────────────────────────────────────────────────────────────
  'chart-bar': (
    <>
      <path d="M3.5 3.5v17h17" />
      <path d="M8.2 16.8V11M12.8 16.8V6.8M17.4 16.8v-4" />
    </>
  ),
  'chart-line': (
    <>
      <path d="M3.5 3.5v17h17" />
      <path d="m7 15.4 3.6-4 3 2.6 4.6-6" />
    </>
  ),
  'trend-up': (
    <>
      <path d="m3.8 16.6 5.4-5.4 3.2 3.2 6.4-6.4" />
      <path d="M14.4 8h4.4v4.4" />
    </>
  ),
  'trend-down': (
    <>
      <path d="m3.8 7.4 5.4 5.4 3.2-3.2 6.4 6.4" />
      <path d="M14.4 16h4.4v-4.4" />
    </>
  ),
  activity: <path d="M21 12h-4l-3 8-4-16-3 8H3" />,

  // ── misc ────────────────────────────────────────────────────────────
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.8 20.4a7.4 7.4 0 0 1 14.4 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.4" cy="8" r="3.6" />
      <path d="M3.4 20.2a6.4 6.4 0 0 1 12 0" />
      <path d="M16.2 4.7a3.6 3.6 0 0 1 0 6.9" />
      <path d="M17.6 14.2a6.4 6.4 0 0 1 3 5.9" />
    </>
  ),
  lock: (
    <>
      <rect x="4.4" y="10.4" width="15.2" height="10.2" rx="2.2" />
      <path d="M7.9 10.4V7.6a4.1 4.1 0 0 1 8.2 0v2.8" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a3.8 3.8 0 0 0 5.7.4l2.4-2.4a3.8 3.8 0 0 0-5.4-5.4l-1.4 1.4" />
      <path d="M13.8 10.2a3.8 3.8 0 0 0-5.7-.4l-2.4 2.4a3.8 3.8 0 0 0 5.4 5.4l1.4-1.4" />
    </>
  ),
  zap: <path d="M13.2 2.6 4.4 13.4h6.6l-.8 8 8.8-10.8h-6.6z" />,
  calendar: (
    <>
      <rect x="3.6" y="5.2" width="16.8" height="15.4" rx="2.2" />
      <path d="M3.6 10h16.8M8.4 3.4v3.6M15.6 3.4v3.6" />
    </>
  ),
  flask: (
    <>
      <path d="M9.6 3.4v5.9L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3l-5.1-8.7V3.4" />
      <path d="M8.4 3.4h7.2" />
      <path d="M7.2 14.6h9.6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.6" />
      <path d="m15.6 15.6 4.4 4.4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 12S6.2 5.4 12 5.4 21.6 12 21.6 12 17.8 18.6 12 18.6 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.6 5.8A8.5 8.5 0 0 1 12 5.4c5.8 0 9.6 6.6 9.6 6.6a16 16 0 0 1-2.8 3.6" />
      <path d="M6.2 7.6A16 16 0 0 0 2.4 12S6.2 18.6 12 18.6a8.8 8.8 0 0 0 3.9-.9" />
      <path d="m3.4 3.4 17.2 17.2" />
    </>
  ),
  wave: (
    <>
      <path d="M6.6 11.4V6.2a1.6 1.6 0 0 1 3.2 0v4.4" />
      <path d="M9.8 10.2V4.8a1.6 1.6 0 0 1 3.2 0v5.4" />
      <path d="M13 10.4V6.4a1.6 1.6 0 0 1 3.2 0v5.4" />
      <path d="M16.2 9.6a1.6 1.6 0 0 1 3.2 0v3.6a7.6 7.6 0 0 1-7.6 7.6 7.6 7.6 0 0 1-7.6-7.6v-.8a1.7 1.7 0 0 1 2.9-1.2l1.5 1.6" />
    </>
  ),
  play: <path d="M7.6 4.9 18.8 12 7.6 19.1z" />,
  'arrow-right': (
    <>
      <path d="M4.4 12h15.2" />
      <path d="m13.4 5.8 6.2 6.2-6.2 6.2" />
    </>
  ),
  menu: <path d="M3.8 7h16.4M3.8 12h16.4M3.8 17h16.4" />,
  mail: (
    <>
      <rect x="2.8" y="5" width="18.4" height="14" rx="2.4" />
      <path d="m3.4 6.8 8.6 6 8.6-6" />
    </>
  ),
  rocket: (
    <>
      <path d="M8.6 15.4c-2.4 1.4-3 5-3 5s3.6-.6 5-3a2.7 2.7 0 0 0-2-2z" />
      <path d="M13.2 13.8 10.2 10.8c1.2-3.2 3.6-7.4 9.4-7.6.2 5.8-4 8.2-7.2 9.4z" />
      <path d="M10.4 10.6 6.6 9.8a1 1 0 0 1-.5-1.7L8.4 5.8M13.4 13.6l.8 3.8a1 1 0 0 0 1.7.5l2.3-2.3" />
    </>
  ),
  'arrow-flat': <path d="M4.4 12h15.2M13.4 5.8l6.2 6.2-6.2 6.2" />,
  external: (
    <>
      <path d="M14.4 4.4h5.2v5.2" />
      <path d="M19.6 4.4 11.2 12.8" />
      <path d="M18 13.8v4.8a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V8.2a2 2 0 0 1 2-2h4.8" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: the link's own text is the accessible name, so announcing
      // the icon too would just read every item twice.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
