import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../env.ts';

/**
 * Two ways to reach Supabase, and the difference matters for security.
 *
 * `serviceClient()` uses the service role key and BYPASSES RLS entirely. It is
 * for the worker and for genuinely platform-level reads (admin dashboard,
 * evaluation). Anything it touches must filter ownership by hand.
 *
 * `userClient(token)` forwards the caller's JWT, so every query runs as that
 * user and Postgres applies the policies from 0006_rls_policies.sql. This is
 * the default for request handling: a route that forgets a `where user_id`
 * clause still cannot leak another user's rows. See D-012.
 */

let service: SupabaseClient | undefined;

export function serviceClient(): SupabaseClient {
  const env = loadEnv();
  service ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return service;
}

/**
 * Per-request, RLS-scoped client. Not cached: it is bound to one user's token.
 */
export function userClient(accessToken: string): SupabaseClient {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Guard for code paths that genuinely need a provider key. Env validation lets
 * these be empty outside production (D-014), so the failure has to be raised
 * where the key is actually used, with a message that says what to do.
 */
export function requireProviderKey(value: string, name: string): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env — see .env.example. ` +
        `AI features are unavailable until it is configured.`,
    );
  }
  return value;
}
