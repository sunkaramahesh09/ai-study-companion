import { normalizeBaseUrl } from './baseUrl.ts';
import { supabase } from './supabase.ts';

const BASE = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * How long a request may hang before the UI gives up.
 *
 * A fetch against a host that accepts the connection and then goes silent
 * never rejects on its own, so without this the spinner spins forever and the
 * user has no error to act on — the worst of both outcomes.
 *
 * Generous, because it has to survive the slowest legitimate case: the
 * provider's TPM limiter WAITS rather than failing (D-033), so a Tutor answer
 * queued behind others can legitimately take most of a minute before the model
 * is even called, on top of a 60s provider timeout.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 150_000;

/** Endpoints where a model call sits behind a rate limiter that waits. */
function timeoutFor(path: string): number {
  return /\/api\/(tutor|quizzes|materials)/.test(path) ? AI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * Called when the API reports the session is no longer valid.
 *
 * Set by the auth provider. A 401 mid-session means the token is expired or
 * revoked, and every subsequent request will fail the same way — so the app
 * returns to sign-in rather than showing "Unauthorized" on every panel.
 */
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

/**
 * Calls the backend with the current session's access token attached.
 *
 * The token is read fresh from the Supabase client on every call rather than
 * captured once: supabase-js refreshes it in the background, and a stale
 * captured token would start returning 401 mid-session.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // Caller-supplied signals still win; the timeout is only a backstop.
  const controller = new AbortController();
  const timeoutMs = timeoutFor(path);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, signal: init.signal ?? controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(
        408,
        `This took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. ` +
          `The server may be busy — please try again.`,
      );
    }
    // fetch rejects for DNS, TLS and offline. The browser's own message
    // ("Failed to fetch") tells a user nothing they can act on.
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  // Guard against a "successful" response that is not from our API at all.
  // A misrouted request served by the frontend host returns index.html with
  // HTTP 200, and parsing that as JSON throws somewhere far from the cause.
  const contentType = res.headers.get('content-type') ?? '';
  if (res.ok && !contentType.includes('application/json')) {
    throw new ApiError(
      res.status,
      `Expected JSON from ${path} but received "${contentType || 'no content-type'}". ` +
        `This usually means VITE_API_BASE_URL is wrong and the request was answered ` +
        `by the frontend host instead of the API.`,
    );
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status line is the best we have.
    }

    // 401 means the token is expired or revoked, so every later request fails
    // identically. 403 is different — the caller is authenticated and simply
    // not permitted — and must NOT sign anyone out.
    if (res.status === 401) onSessionExpired?.();

    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}
