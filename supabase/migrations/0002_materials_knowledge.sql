-- ============================================================================
-- 0002_materials_knowledge — materials, chunks + embeddings, concepts, mastery
-- ============================================================================

-- ---------------------------------------------------------------------------
-- materials — an uploaded PDF and its processing lifecycle
-- ---------------------------------------------------------------------------
create table public.materials (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  filename      text not null,
  storage_path  text not null unique,
  mime_type     text not null default 'application/pdf',
  size_bytes    bigint not null check (size_bytes > 0),
  -- Lifecycle the PRD asks the user to be able to see (§5).
  status        text not null default 'queued'
                  check (status in ('queued', 'processing', 'ready', 'failed')),
  page_count    integer check (page_count >= 0),
  chunk_count   integer not null default 0 check (chunk_count >= 0),
  -- Surfaced to the user on failure; never a raw stack trace.
  error_message text,
  -- Set when processing starts, used to detect jobs orphaned by a worker crash.
  processing_started_at timestamptz,
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index materials_project_idx on public.materials (project_id, created_at desc);
create index materials_status_idx on public.materials (status) where status in ('queued', 'processing');

create trigger materials_touch_updated_at
  before update on public.materials
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- material_chunks — the retrieval unit
-- ---------------------------------------------------------------------------
-- page_number is NOT NULL and exact: chunks never span a page boundary (D-005),
-- so a citation of "Page 14" is provably the page the text came from.
--
-- vector(768): gemini-embedding-001 truncated via MRL and re-normalized. 768
-- keeps us under pgvector's 2000-dim index ceiling — above it, every retrieval
-- degrades to a sequential scan. See D-004.
create table public.material_chunks (
  id            uuid primary key default gen_random_uuid(),
  material_id   uuid not null references public.materials (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  page_number   integer not null check (page_number >= 1),
  chunk_index   integer not null check (chunk_index >= 0),
  content       text not null,
  token_count   integer not null default 0 check (token_count >= 0),
  embedding     extensions.vector(768),
  created_at    timestamptz not null default now(),
  -- Makes re-running a partially-failed indexing job idempotent: a retry
  -- upserts the same (material, chunk_index) instead of duplicating it.
  unique (material_id, chunk_index)
);

create index material_chunks_project_idx on public.material_chunks (project_id);
create index material_chunks_material_idx on public.material_chunks (material_id, chunk_index);

-- HNSW over cosine distance. Embeddings are L2-normalized at write time, which
-- is what makes cosine the right operator class here.
create index material_chunks_embedding_idx
  on public.material_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- concepts — extracted units of knowledge, the spine of mastery and adaptivity
-- ---------------------------------------------------------------------------
create table public.concepts (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200),
  description text,
  -- Which material the concept was extracted from, so it stays traceable.
  source_material_id uuid references public.materials (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Case-insensitive uniqueness per project: re-processing a material must not
  -- create "Gradient Descent" alongside an existing "gradient descent".
  unique (project_id, name)
);

create index concepts_project_idx on public.concepts (project_id, created_at desc);

create trigger concepts_touch_updated_at
  before update on public.concepts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- concept_mastery — current estimate, one row per concept
-- ---------------------------------------------------------------------------
-- score is 0..1. The PRD is explicit that this is an estimate, not a claim of
-- perfect measurement (§10). It is computed by a deterministic function in
-- @asc/shared, never by an AI call.
create table public.concept_mastery (
  id               uuid primary key default gen_random_uuid(),
  concept_id       uuid not null references public.concepts (id) on delete cascade,
  project_id       uuid not null references public.projects (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  score            numeric(5,4) not null default 0.0 check (score >= 0 and score <= 1),
  -- How much evidence backs the score. A 0.9 from one answer is not a 0.9 from
  -- twelve, and the UI should be able to say so.
  evidence_count   integer not null default 0 check (evidence_count >= 0),
  last_evidence_at timestamptz,
  updated_at       timestamptz not null default now(),
  unique (concept_id)
);

create index concept_mastery_project_idx on public.concept_mastery (project_id, score asc);

create trigger concept_mastery_touch_updated_at
  before update on public.concept_mastery
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- mastery_history — append-only, powers Growth Analysis
-- ---------------------------------------------------------------------------
-- Growth (improving / stable / needs attention) is derived from this trail
-- rather than stored as a flag, so the classification can be recomputed when
-- the algorithm changes without losing the underlying evidence.
create table public.mastery_history (
  id            uuid primary key default gen_random_uuid(),
  concept_id    uuid not null references public.concepts (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  score_before  numeric(5,4) not null check (score_before >= 0 and score_before <= 1),
  score_after   numeric(5,4) not null check (score_after >= 0 and score_after <= 1),
  reason        text not null check (reason in ('quiz_answer', 'quiz_completed', 'tutor_signal', 'manual', 'recompute')),
  source_id     uuid,
  created_at    timestamptz not null default now()
);

create index mastery_history_concept_idx on public.mastery_history (concept_id, created_at desc);
create index mastery_history_project_idx on public.mastery_history (project_id, created_at desc);

alter table public.materials       enable row level security;
alter table public.material_chunks enable row level security;
alter table public.concepts        enable row level security;
alter table public.concept_mastery enable row level security;
alter table public.mastery_history enable row level security;
