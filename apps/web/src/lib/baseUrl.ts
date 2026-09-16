/**
 * Normalizes the configured API base URL.
 *
 * A base URL without a scheme (`api.example.com` instead of
 * `https://api.example.com`) is the nastiest possible misconfiguration here,
 * because nothing errors. `fetch()` treats a schemeless value as a RELATIVE
 * path, so every request goes to the frontend's own origin, matches the SPA
 * rewrite in vercel.json, and returns index.html with HTTP 200. The app sees a
 * "successful" response and then fails somewhere unrelated trying to read JSON
 * out of HTML.
 *
 * This happened on the first production deploy. Assuming https is the right
 * recovery: the only realistic cause is a deployment variable set to a bare
 * hostname, and there is no case where a schemeless absolute host is meant to
 * be resolved against the frontend origin.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');

  // Empty is legitimate: same-origin deployments call /api/... directly.
  if (!value) return '';

  if (/^https?:\/\//i.test(value)) return value;

  // Protocol-relative ("//host") is also absolute; leave it alone.
  if (value.startsWith('//')) return value;

  console.warn(
    `[api] VITE_API_BASE_URL is "${value}" with no scheme. ` +
      `Assuming https://${value} — set the full URL in the deployment config.`,
  );
  return `https://${value}`;
}
