-- ============================================================================
-- 0006_rls_policies — Project-level data isolation
-- ============================================================================
-- "Users must only access their own Spaces and Projects. Materials and
--  retrieval must remain isolated." (PRD §15)
--
-- Three rules this migration follows:
--
-- 1. Ownership predicates are `user_id = (select auth.uid())` with no joins.
--    That is why user_id is denormalized onto every descendant (D-009) — an
--    isolation policy you cannot read in one line is an isolation policy you
--    cannot audit. The subselect form lets Postgres evaluate auth.uid() once
--    per statement as an InitPlan instead of once per row.
--
-- 2. Least privilege by default. Tables that only the backend writes
--    (chunks, concepts, mastery, events, ai_requests, ...) get a SELECT policy
--    and nothing else. There is no INSERT/UPDATE/DELETE policy for
--    `authenticated`, so those writes are impossible through the anon key no
--    matter what the client sends. The worker uses the service role, which
--    bypasses RLS — and therefore carries ownership in its job payload and
--    filters explicitly (see worker.ts).
--
-- 3. Inserts verify the *parent* too. A row carrying your own user_id but
--    someone else's project_id would pass a naive check, so child inserts also
--    assert owns_project().
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Ownership helpers
-- ---------------------------------------------------------------------------
create or replace function public.owns_space(p_space_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.spaces s
    where s.id = p_space_id and s.user_id = (select auth.uid())
  );
$$;

create or replace function public.owns_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.user_id = (select auth.uid())
  );
$$;

-- Default EXECUTE goes to PUBLIC, which PostgREST publishes as an RPC endpoint.
-- Revoke first, then grant narrowly — the lesson from D-011.
revoke execute on function public.owns_space(uuid)   from public, anon;
revoke execute on function public.owns_project(uuid) from public, anon;
grant  execute on function public.owns_space(uuid)   to authenticated;
grant  execute on function public.owns_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Privilege escalation guard. RLS decides which ROWS you may touch; it says
-- nothing about which COLUMNS. With table-level UPDATE, a user could satisfy
-- `id = auth.uid()` and set their own role to 'admin'. Postgres ignores a
-- REVOKE on a column while table-level UPDATE is held, so the table grant must
-- be dropped and replaced by an explicit column allowlist.
revoke update on public.profiles from authenticated;
grant  update (full_name) on public.profiles to authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT policy: profiles are created by the on_auth_user_created trigger.
-- No DELETE policy: account deletion cascades from auth.users.

-- ---------------------------------------------------------------------------
-- spaces
-- ---------------------------------------------------------------------------
create policy spaces_select on public.spaces for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy spaces_insert on public.spaces for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy spaces_update on public.spaces for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy spaces_delete on public.spaces for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create policy projects_select on public.projects for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy projects_insert on public.projects for insert to authenticated
  with check (user_id = (select auth.uid()) and public.owns_space(space_id));
create policy projects_update on public.projects for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_space(space_id));
create policy projects_delete on public.projects for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- materials — user manages; worker processes
-- ---------------------------------------------------------------------------
create policy materials_select on public.materials for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy materials_insert on public.materials for insert to authenticated
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy materials_delete on public.materials for delete to authenticated
  using (user_id = (select auth.uid()));
-- No UPDATE policy: status transitions are the worker's job, not the client's.
-- A user who could set status='ready' would strand an unindexed document in a
-- state the Tutor believes is searchable.

-- ---------------------------------------------------------------------------
-- Backend-written tables: SELECT only for the owner.
-- ---------------------------------------------------------------------------
create policy material_chunks_select on public.material_chunks for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy concepts_select on public.concepts for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy concept_mastery_select on public.concept_mastery for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy mastery_history_select on public.mastery_history for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy question_bank_select on public.question_bank for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy learner_facts_select on public.learner_facts for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy learning_events_select on public.learning_events for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy ai_requests_select on public.ai_requests for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- ---------------------------------------------------------------------------
-- conversations / messages
-- ---------------------------------------------------------------------------
create policy conversations_select on public.conversations for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy conversations_insert on public.conversations for insert to authenticated
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy conversations_update on public.conversations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy conversations_delete on public.conversations for delete to authenticated
  using (user_id = (select auth.uid()));

create policy messages_select on public.messages for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
-- No UPDATE/DELETE: the conversation transcript is evidence for mastery and
-- evaluation. Letting a client rewrite history would corrupt both.

-- ---------------------------------------------------------------------------
-- quizzes
-- ---------------------------------------------------------------------------
create policy quiz_attempts_select on public.quiz_attempts for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy quiz_attempts_insert on public.quiz_attempts for insert to authenticated
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy quiz_attempts_update on public.quiz_attempts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy quiz_questions_select on public.quiz_questions for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
-- Questions are generated and graded server-side. The client submitting an
-- answer goes through the API, not a direct table write, so grading and the
-- correct_index stay out of reach.

-- ---------------------------------------------------------------------------
-- recommendations — user may act on them (dismiss / complete)
-- ---------------------------------------------------------------------------
create policy recommendations_select on public.recommendations for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy recommendations_update on public.recommendations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- evaluation — platform-level, admin only
-- ---------------------------------------------------------------------------
-- No user_id column: eval runs are about the system, not about a learner.
create policy eval_runs_select on public.eval_runs for select to authenticated
  using (public.is_admin());
create policy eval_results_select on public.eval_results for select to authenticated
  using (public.is_admin());
