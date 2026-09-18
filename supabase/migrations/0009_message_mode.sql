-- ---------------------------------------------------------------------------
-- 0009 — messages.mode: which half of the Tutor answered
-- ---------------------------------------------------------------------------
-- The Tutor answers two different kinds of question from two different sources.
-- A material question is grounded in the learner's uploaded documents and
-- carries citations back to a page. A progress question — "where was I, how am
-- I doing, what should I do next?" — is grounded in the learner's own record:
-- concept mastery, quiz history, repeated mistakes. Nothing in a PDF knows how
-- a learner is doing, and asking retrieval that question produced a cited
-- fabrication (D-075).
--
-- Without this column the two are indistinguishable after the fact: a progress
-- answer has no citations, which is exactly what an ungrounded material answer
-- also looks like. The UI needs the difference to label the turn honestly
-- rather than showing "Based on your materials" over a progress report, and the
-- analytics need it to separate a refusal from a report.
--
-- Nullable with no default: every row written before this migration predates
-- the progress path, and backfilling them to 'material' would assert something
-- about turns nobody classified. NULL means "not recorded", which is true.
alter table public.messages
  add column if not exists mode text
    check (mode is null or mode in ('material', 'progress'));

comment on column public.messages.mode is
  'Which Tutor path produced an assistant turn: material (RAG over uploads, cited) or progress (the learner''s own record). NULL for turns written before 0009.';
