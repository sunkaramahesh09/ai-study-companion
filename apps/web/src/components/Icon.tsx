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
  | 'home'
  | 'tutor'
  | 'quiz'
  | 'progress'
  | 'cap'
  | 'plus'
  | 'settings'
  | 'logout';

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
