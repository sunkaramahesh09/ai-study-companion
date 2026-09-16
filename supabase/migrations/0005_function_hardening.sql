-- ============================================================================
-- 0005_function_hardening — stop trigger functions being callable over the API
-- ============================================================================
-- Postgres grants EXECUTE on new functions to PUBLIC by default. Because
-- PostgREST exposes the `public` schema, that turned three SECURITY DEFINER
-- functions into live RPC endpoints at /rest/v1/rpc/<name>, callable by anyone
-- holding the anon key. Caught by the Supabase security advisor
-- (lint 0028/0029) immediately after 0004. See D-011.
--
-- Triggers are unaffected: a trigger function runs as part of the triggering
-- statement and does not require an EXECUTE grant on the invoking role.

revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- is_admin() stays callable by `authenticated` on purpose: RLS policy
-- expressions are evaluated as the querying role, so the policies added in
-- 0006 need this grant. It leaks nothing — it answers "am I an admin?" about
-- the caller only. `anon` has no business asking.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
