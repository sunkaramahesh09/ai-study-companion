-- ============================================================================
-- 0001_foundation — extensions, helpers, profiles, spaces, projects
-- ============================================================================
-- RLS is enabled on every table in this migration but NO policies are created
-- here. With RLS on and no policy, Postgres denies all access by default, so
-- there is never a window where a table exists and is readable. Policies land
-- in 0005_rls_policies (task 3). See D-010.
-- ============================================================================

create extension if not exists vector with schema extensions;

-- Keeps updated_at honest without every writer having to remember it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user. Carries the admin flag.
-- ---------------------------------------------------------------------------
-- role lives here rather than in JWT app_metadata so an admin check is a plain
-- join the database can enforce in an RLS policy, instead of trusting a claim
-- the client presents.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Auto-create a profile when a user signs up, so application code never has to
-- handle a logged-in user with no profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin check used by RLS policies and admin-only endpoints.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- spaces — a broad learning area
-- ---------------------------------------------------------------------------
create table public.spaces (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  description text check (length(description) <= 2000),
  color       text,
  icon        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index spaces_user_id_idx on public.spaces (user_id, created_at desc);

create trigger spaces_touch_updated_at
  before update on public.spaces
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- projects — the core learning workspace
-- ---------------------------------------------------------------------------
-- user_id is denormalized from spaces on purpose (D-009): every RLS policy on
-- every descendant table becomes `user_id = auth.uid()` with no joins, which
-- keeps isolation both fast and easy to audit by reading one line.
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  space_id      uuid not null references public.spaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  description   text check (length(description) <= 2000),
  -- The learning goal. Feeds Tutor context and recommendation generation.
  goal          text check (length(goal) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create index projects_user_id_idx on public.projects (user_id, last_active_at desc);
create index projects_space_id_idx on public.projects (space_id, created_at desc);

create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.spaces   enable row level security;
alter table public.projects enable row level security;
