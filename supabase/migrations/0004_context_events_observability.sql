-- ============================================================================
-- 0004_context_events_observability — learner context, recommendations,
--                                     learning events, AI usage, evaluation
-- ============================================================================

-- ---------------------------------------------------------------------------
-- learner_facts — persistent, *relevant* learning context
-- ---------------------------------------------------------------------------
-- The PRD is pointed about this: "prioritize relevance rather than storing
-- everything" (§11). So this is a small, curated table of durable facts, not a
-- transcript archive. `salience` lets retrieval take the top-N facts for the
-- current task instead of dumping the learner's whole history into a prompt —
-- which also matters because Groq's 8000 TPM is the binding constraint.
create table public.learner_facts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('goal', 'strength', 'weakness', 'preference', 'mistake_pattern')),
  content      text not null check (length(content) <= 1000),
  concept_id   uuid references public.concepts (id) on delete cascade,
  -- 0..1. Decays over time; refreshed when the fact is re-observed.
  salience     numeric(5,4) not null default 0.5 check (salience >= 0 and salience <= 1),
  evidence_count integer not null default 1 check (evidence_count >= 1),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  -- One fact per (project, kind, concept): re-observing a weakness bumps
  -- salience and evidence_count instead of appending a near-duplicate.
  unique (project_id, kind, concept_id)
);

create index learner_facts_retrieval_idx
  on public.learner_facts (project_id, salience desc, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- recommendations — "what should I do next?"
-- ---------------------------------------------------------------------------
-- WHETHER to recommend is decided by deterministic trigger rules in @asc/shared.
-- Only the sentence itself is generated. trigger_reason records which rule
-- fired, so a recommendation is explainable and the eval suite can check that
-- the text matches the state that produced it.
create table public.recommendations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  concept_id     uuid references public.concepts (id) on delete set null,
  trigger_reason text not null check (trigger_reason in (
    'quiz_completed', 'weak_concept', 'repeated_mistake', 'stale_project', 'material_ready'
  )),
  title          text not null,
  body           text not null,
  -- What the UI should do when the user accepts.
  action_type    text not null default 'review_material'
                   check (action_type in ('review_material', 'take_quiz', 'ask_tutor', 'upload_material')),
  status         text not null default 'active'
                   check (status in ('active', 'dismissed', 'completed', 'superseded')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index recommendations_active_idx
  on public.recommendations (project_id, created_at desc) where status = 'active';

-- ---------------------------------------------------------------------------
-- learning_events — append-only activity spine
-- ---------------------------------------------------------------------------
-- Feeds user-facing activity, analytics, recommendations and admin visibility
-- (§12) from one source rather than four divergent ones.
--
-- idempotency_key makes event emission safe to retry: a background job that
-- runs twice records the event once. The PRD asks for this directly —
-- "consider retries, duplicate events, and idempotency".
create table public.learning_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  project_id      uuid references public.projects (id) on delete cascade,
  space_id        uuid references public.spaces (id) on delete cascade,
  event_type      text not null check (event_type in (
    'space_created', 'project_created',
    'material_uploaded', 'material_processing', 'material_ready', 'material_failed',
    'tutor_question', 'tutor_answer', 'tutor_unsupported',
    'quiz_started', 'question_answered', 'quiz_completed',
    'mastery_updated', 'weakness_detected', 'recommendation_created'
  )),
  payload         jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);

create index learning_events_user_idx on public.learning_events (user_id, created_at desc);
create index learning_events_project_idx on public.learning_events (project_id, created_at desc);
create index learning_events_type_idx on public.learning_events (event_type, created_at desc);

-- ---------------------------------------------------------------------------
-- ai_requests — one row per provider call, no exceptions
-- ---------------------------------------------------------------------------
-- This is the whole AI observability story (§14). It has to answer: why was a
-- response slow, which model ran, how much did it cost, which workflow failed,
-- and did we fall back?
create table public.ai_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.profiles (id) on delete set null,
  project_id      uuid references public.projects (id) on delete cascade,
  -- Which product surface spent the tokens.
  feature         text not null check (feature in (
    'tutor_answer', 'concept_extraction', 'question_generation',
    'open_answer_grading', 'recommendation', 'embedding', 'evaluation'
  )),
  provider        text not null check (provider in ('groq', 'gemini')),
  model           text not null,
  -- True when the primary model 429'd and we failed over to the fallback.
  used_fallback   boolean not null default false,
  status          text not null check (status in ('success', 'error', 'rate_limited', 'invalid_output', 'timeout')),
  latency_ms      integer check (latency_ms >= 0),
  prompt_tokens   integer check (prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens >= 0),
  total_tokens    integer check (total_tokens >= 0),
  estimated_cost_usd numeric(12,8),
  -- How many backoff attempts it took. A rising trend here is the early signal
  -- that we are pressed against the TPM ceiling.
  attempt_count   integer not null default 1 check (attempt_count >= 1),
  error_code      text,
  error_message   text,
  created_at      timestamptz not null default now()
);

create index ai_requests_created_idx on public.ai_requests (created_at desc);
create index ai_requests_feature_idx on public.ai_requests (feature, created_at desc);
create index ai_requests_project_idx on public.ai_requests (project_id, created_at desc);
create index ai_requests_failures_idx
  on public.ai_requests (created_at desc) where status <> 'success';

-- ---------------------------------------------------------------------------
-- eval_runs / eval_results — regression visibility for AI behavior
-- ---------------------------------------------------------------------------
-- The PRD asks for awareness that prompt, model or retrieval changes cause
-- regressions (§14). Persisting runs makes that comparable over time instead of
-- being a number that scrolls past in a terminal.
create table public.eval_runs (
  id          uuid primary key default gen_random_uuid(),
  git_sha     text,
  notes       text,
  -- { suite: { passed, failed, mean_score } }
  summary     jsonb not null default '{}'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create table public.eval_results (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.eval_runs (id) on delete cascade,
  suite      text not null check (suite in ('tutor', 'retrieval', 'assessment', 'recommendation', 'security')),
  case_id    text not null,
  passed     boolean not null,
  score      numeric(5,4) check (score >= 0 and score <= 1),
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index eval_results_run_idx on public.eval_results (run_id, suite);

alter table public.learner_facts    enable row level security;
alter table public.recommendations  enable row level security;
alter table public.learning_events  enable row level security;
alter table public.ai_requests      enable row level security;
alter table public.eval_runs        enable row level security;
alter table public.eval_results     enable row level security;
