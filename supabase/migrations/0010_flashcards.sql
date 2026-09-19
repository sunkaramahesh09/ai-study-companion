-- ---------------------------------------------------------------------------
-- 0010 — flashcards: a per-Project deck with deterministic spaced review
-- ---------------------------------------------------------------------------
-- PRD "Nice to Have" names flashcards and spaced repetition explicitly, with
-- the condition that a creative feature "should not compromise the core
-- learning experience". So this is built out of parts the core already has and
-- adds no new dependency and no second source of truth:
--
--   · WHICH concepts get a deck is decided by the same deterministic selector
--     that drives quizzes — weakest and least-evidenced first (D-080).
--   · WHEN a card comes back is an SM-2-derived pure function in @asc/shared.
--     No AI, no stored flag, no clock read inside the algorithm.
--   · Only the WORDING of a card is generated, on the fallback tier, validated
--     against a zod schema before it is persisted (PRD §8).
--
-- One row per card, review state on the row. Unlike question_bank — a shared
-- cache keyed by (concept, difficulty) — a card carries a learner's own review
-- history, so it is never reused across accounts and never cached.
-- ---------------------------------------------------------------------------

create table public.flashcards (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  -- Nullable: a concept can be deleted and re-extracted when a material is
  -- reprocessed, and losing the link is better than losing the card.
  concept_id  uuid references public.concepts (id) on delete set null,
  front       text not null check (length(trim(front)) between 3 and 300),
  back        text not null check (length(trim(back)) between 3 and 800),
  hint        text check (hint is null or length(trim(hint)) between 1 and 200),
  -- Which chunks the card was written from, so a card stays traceable to the
  -- page it came from — the same contract as a Tutor citation.
  source_chunk_ids uuid[] not null default '{}',

  -- --- review state, written only by the scheduler in @asc/shared -----------
  -- due_at defaults to now(): a new card is due immediately, which is what a
  -- learner who just generated a deck expects.
  due_at           timestamptz not null default now(),
  interval_days    numeric(6,2) not null default 0 check (interval_days >= 0),
  -- SM-2's ease factor. Clamped in the algorithm as well as here, because a
  -- constraint that only exists in Postgres fails at 3am instead of in a test.
  ease             numeric(4,2) not null default 2.50 check (ease >= 1.30 and ease <= 3.00),
  reps             integer not null default 0 check (reps >= 0),
  lapses           integer not null default 0 check (lapses >= 0),
  last_rating      text check (last_rating is null or last_rating in ('again', 'hard', 'good', 'easy')),
  last_reviewed_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Regenerating a deck must not produce the same card twice. This is what
  -- makes generation idempotent, the same way (material_id, chunk_index) makes
  -- indexing idempotent (D-026).
  unique (project_id, front)
);

-- The review queue's only query: this learner's cards in this project, soonest
-- due first.
create index flashcards_due_idx on public.flashcards (user_id, project_id, due_at);
create index flashcards_concept_idx on public.flashcards (concept_id);

create trigger flashcards_touch_updated_at
  before update on public.flashcards
  for each row execute function public.touch_updated_at();

alter table public.flashcards enable row level security;

-- SELECT only, like every other table the backend owns (0006, rule 2). A
-- client that could UPDATE this table could set its own due_at and ease — that
-- is, grade its own recall — so every write goes through the API with the
-- service role after an ownership check, and the schedule is computed server
-- side from the rating alone.
create policy flashcards_select on public.flashcards for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

comment on table public.flashcards is
  'Per-learner flashcards for a Project. Card wording is generated; which concept it covers and when it next appears are deterministic (D-080).';

-- ---------------------------------------------------------------------------
-- The two enumerations that have to know about the new surface
-- ---------------------------------------------------------------------------
-- Both are CHECK constraints rather than enums, so they widen with a drop and
-- re-add. Named explicitly: an unnamed constraint gets a generated name that
-- differs between a fresh database and a migrated one.
alter table public.learning_events drop constraint learning_events_event_type_check;
alter table public.learning_events add constraint learning_events_event_type_check
  check (event_type in (
    'space_created', 'project_created',
    'material_uploaded', 'material_processing', 'material_ready', 'material_failed',
    'tutor_question', 'tutor_answer', 'tutor_unsupported',
    'quiz_started', 'question_answered', 'quiz_completed',
    'mastery_updated', 'weakness_detected', 'recommendation_created',
    'flashcards_generated', 'flashcard_reviewed'
  ));

alter table public.ai_requests drop constraint ai_requests_feature_check;
alter table public.ai_requests add constraint ai_requests_feature_check
  check (feature in (
    'tutor_answer', 'concept_extraction', 'question_generation',
    'open_answer_grading', 'recommendation', 'embedding', 'evaluation',
    'flashcard_generation'
  ));
