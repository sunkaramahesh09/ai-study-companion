import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. See .env.example.',
  );
}

/**
 * The publishable (anon) key is meant to ship in the browser bundle. It grants
 * nothing on its own — RLS decides what a given user may read or write
 * (0006_rls_policies.sql). The service role key must never appear here.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
