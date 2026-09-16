-- ============================================================================
-- 0008_match_chunks — project-scoped vector similarity search
-- ============================================================================
-- PostgREST cannot express pgvector's `<=>` operator, so retrieval goes through
-- an RPC.
--
-- The `<=>` operator lives in the `extensions` schema, and `search_path = ''`
-- (which is what stops a caller shadowing our table names) hides it. Qualifying
-- the operator explicitly keeps the hardening rather than widening the path.
--
-- SECURITY INVOKER, deliberately. The body runs as the CALLER, so the RLS
-- policy on material_chunks still applies and a user can only ever match their
-- own chunks — even if a caller passed someone else's project_id. The explicit
-- project filter is the second layer: isolation should not depend on one
-- predicate being right (D-012).
--
-- The worker calls this with the service role, which bypasses RLS, and is
-- correct because it filters by project_id from the job payload.
-- ============================================================================

create or replace function public.match_material_chunks(
  p_project_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_count int default 8,
  p_max_distance double precision default 0.75
)
returns table (
  id uuid,
  material_id uuid,
  filename text,
  page_number int,
  chunk_index int,
  content text,
  distance double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.material_id,
    m.filename,
    c.page_number,
    c.chunk_index,
    c.content,
    (c.embedding operator(extensions.<=>) p_query_embedding)::double precision as distance
  from public.material_chunks c
  join public.materials m on m.id = c.material_id
  where c.project_id = p_project_id
    -- A chunk whose embedding failed must never be retrieved: it would be
    -- ordered arbitrarily and could displace a genuinely relevant result.
    and c.embedding is not null
    -- Distance ceiling, not just top-k. Without it the Tutor always receives
    -- its k "best" chunks even when nothing is relevant, which is exactly how
    -- an unsupported question turns into a confident fabrication (PRD §7).
    and (c.embedding operator(extensions.<=>) p_query_embedding) <= p_max_distance
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
$$;

-- Default EXECUTE goes to PUBLIC; revoke first, then grant narrowly (D-011).
revoke execute on function public.match_material_chunks(uuid, extensions.vector, int, double precision)
  from public, anon;
grant execute on function public.match_material_chunks(uuid, extensions.vector, int, double precision)
  to authenticated;

-- Reports how much of a project is actually searchable. The Tutor needs this to
-- distinguish "no relevant evidence" from "nothing has been indexed yet" —
-- those deserve very different answers.
create or replace function public.project_index_stats(p_project_id uuid)
returns table (
  total_chunks bigint,
  embedded_chunks bigint,
  ready_materials bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from public.material_chunks c where c.project_id = p_project_id),
    (select count(*) from public.material_chunks c where c.project_id = p_project_id and c.embedding is not null),
    (select count(*) from public.materials m where m.project_id = p_project_id and m.status = 'ready');
$$;

revoke execute on function public.project_index_stats(uuid) from public, anon;
grant execute on function public.project_index_stats(uuid) to authenticated;
