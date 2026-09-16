-- ============================================================================
-- 0003_tutor_assessment — conversations, messages, quizzes, question bank
-- ============================================================================

-- ---------------------------------------------------------------------------
-- conversations / messages — the Tutor experience
-- ---------------------------------------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_project_idx on public.conversations (project_id, updated_at desc);

create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();

-- citations: [{ material_id, filename, page_number, chunk_id, snippet }]
-- Stored per message so the UI can link the user back to the source page, and
-- so the evaluation suite can check citation correctness after the fact
-- rather than only at generation time.
--
-- grounded=false records that the Tutor declined for lack of evidence. That is
-- a first-class outcome, not an error: the PRD makes refusing to fabricate a
-- core evaluation requirement (§7), and storing it lets us measure how often
-- it happens.
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  citations       jsonb not null default '[]'::jsonb,
  grounded        boolean,
  -- Retrieval + generation trace for this turn, for debugging "why was the
  -- context poor?" (PRD §14).
  ai_request_id   uuid,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at asc);
create index messages_project_idx on public.messages (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- quiz_attempts / quiz_questions — adaptive assessment
-- ---------------------------------------------------------------------------
create table public.quiz_attempts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'in_progress'
                  check (status in ('in_progress', 'completed', 'abandoned')),
  -- Requested length; the adaptive loop may stop early.
  target_length integer not null default 5 check (target_length between 1 and 20),
  questions_answered integer not null default 0 check (questions_answered >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  -- 0..1, computed deterministically on completion.
  score         numeric(5,4) check (score >= 0 and score <= 1),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index quiz_attempts_project_idx on public.quiz_attempts (project_id, started_at desc);
create index quiz_attempts_open_idx on public.quiz_attempts (user_id) where status = 'in_progress';

-- difficulty is 1..5 and is chosen by a deterministic selector in @asc/shared,
-- not by the model. The PRD explicitly rejects "wrong -> easy, correct -> hard"
-- (§9), so the selector reads mastery, recent mistakes, coverage and question
-- history; only the question's wording is generated.
create table public.quiz_questions (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references public.quiz_attempts (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  concept_id    uuid references public.concepts (id) on delete set null,
  position      integer not null check (position >= 0),
  question_type text not null check (question_type in ('mcq', 'open')),
  difficulty    integer not null check (difficulty between 1 and 5),
  prompt        text not null,
  -- MCQ only: ["...", "...", ...]
  options       jsonb,
  -- MCQ only: index into options.
  correct_index integer,
  -- Open-ended only: the key points a good answer should cover. Used by the
  -- grader and shown in feedback as "what was missing".
  expected_points jsonb,
  -- Where the question came from, so grading can stay grounded in material.
  source_chunk_ids uuid[],
  user_answer   text,
  is_correct    boolean,
  score         numeric(5,4) check (score >= 0 and score <= 1),
  -- { summary, understood[], missing[], suggestion }
  feedback      jsonb,
  answered_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (attempt_id, position)
);

create index quiz_questions_attempt_idx on public.quiz_questions (attempt_id, position asc);
create index quiz_questions_concept_idx on public.quiz_questions (concept_id, created_at desc);
-- Powers repeated-mistake detection: recent wrong answers by concept.
create index quiz_questions_wrong_idx
  on public.quiz_questions (user_id, concept_id, answered_at desc)
  where is_correct = false;

-- ---------------------------------------------------------------------------
-- question_bank — cache of genuinely reusable generations
-- ---------------------------------------------------------------------------
-- A question for (concept, difficulty, type) is reusable: it does not depend on
-- anything about this moment. A Tutor answer to a user's free-text question is
-- NOT reusable and is deliberately never cached — caching it would return a
-- stale answer to a different question, which is a correctness bug, not a
-- performance win. See CLAUDE.md "Engineering principles".
create table public.question_bank (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  concept_id    uuid not null references public.concepts (id) on delete cascade,
  question_type text not null check (question_type in ('mcq', 'open')),
  difficulty    integer not null check (difficulty between 1 and 5),
  prompt        text not null,
  options       jsonb,
  correct_index integer,
  expected_points jsonb,
  source_chunk_ids uuid[],
  times_used    integer not null default 0 check (times_used >= 0),
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index question_bank_lookup_idx
  on public.question_bank (concept_id, question_type, difficulty, times_used asc);

alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.quiz_attempts  enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.question_bank  enable row level security;
