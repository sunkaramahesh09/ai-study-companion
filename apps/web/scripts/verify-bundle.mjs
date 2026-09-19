/**
 * Postbuild smoke check: did the application actually make it into the bundle?
 *
 * This exists because a build can succeed and emit a bundle with no app in it.
 * `src/lib/supabase.ts` throws at module scope when its env is missing; in a
 * production build that throw is provably unconditional, so the minifier
 * eliminates everything downstream of it as dead code. The result is a green
 * build log, a plausible bundle size, and a blank page. See D-052.
 *
 * The env guard in vite.config.ts prevents the known cause. This checks the
 * OUTPUT instead of the cause, so a different cause with the same symptom —
 * a bad tree-shake, a misconfigured entry — cannot ship quietly either.
 *
 * The markers are EXPORTED because `scripts/rehearse-production.mjs` runs the
 * same check against the DEPLOYED bundle. It used to keep its own copy of this
 * list, which silently went stale when the redesign renamed "Concept mastery"
 * to "Concept Mastery" — the rehearsal then reported the production bundle as
 * empty when it was fine. One list, two readers (D-086).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Strings that only exist because the app is present. Deliberately spread
 * across separate route and component files: one marker could survive while
 * most of the app vanished.
 *
 * These are user-visible copy, so changing that copy changes this list. That
 * is the intended coupling: a marker that no longer appears anywhere in the
 * app is a marker that proves nothing.
 */
export const MARKERS = [
  'Ask the Tutor',       // ProjectDashboard
  'Concept Mastery',     // ProjectDashboard
  'Learning activity',   // AnalyticsPanels
  'Needs attention',     // Growth
];

/** Vendor code alone is ~260 kB; a real bundle is far larger. */
export const MIN_BYTES = 400_000;

/** Shared by both readers so the verdict cannot differ between them. */
export function missingMarkers(source) {
  return MARKERS.filter((m) => !source.includes(m));
}

const ASSETS = new URL('../dist/assets/', import.meta.url).pathname;

// Only check the local build when run as a script; importing this module must
// not try to read a dist/ the importer does not have.
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main();
}

function main() {
  let files;
  try {
    files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  } catch {
    fail(`No build output at ${ASSETS}. Did vite build run?`);
  }

  if (files.length === 0) fail('Build produced no JavaScript.');

  const combined = files.map((f) => readFileSync(join(ASSETS, f), 'utf8')).join('\n');
  const bytes = files.reduce((sum, f) => sum + statSync(join(ASSETS, f)).size, 0);

  const missing = missingMarkers(combined);

  if (missing.length > 0 || bytes < MIN_BYTES) {
    fail(
      `The bundle does not contain the application.\n` +
        `  size:    ${bytes.toLocaleString()} bytes (expected at least ${MIN_BYTES.toLocaleString()})\n` +
        `  missing: ${missing.length > 0 ? missing.join(', ') : 'none'}\n\n` +
        `The usual cause is a module-scope throw that the minifier proved unconditional —\n` +
        `most often missing VITE_* environment variables. See D-052.`,
    );
  }

  console.log(
    `[verify-bundle] ok — ${files.length} file(s), ${bytes.toLocaleString()} bytes, all ${MARKERS.length} markers present`,
  );
}

function fail(message) {
  console.error(`\n[verify-bundle] FAILED\n${message}\n`);
  process.exit(1);
}
