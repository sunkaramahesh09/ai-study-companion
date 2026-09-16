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

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

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
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}
