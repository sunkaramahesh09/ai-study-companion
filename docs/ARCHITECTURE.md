# Architecture

*Submission requirement §20.4 — an architecture diagram and the major
architectural decisions.*

The full decision record, with the alternative rejected in each case, is
[`DECISIONS.md`](DECISIONS.md) — 88 numbered entries, written as the work
happened. This document is the map; that one is the reasoning.

---

## 1. System

```
        BROWSER
    ┌──────────────────┐
    │ @asc/web         │  React 19 + TypeScript, Vite, SPA
    │ Vercel           │  supabase-js holds the session only
    └────────┬─────────┘
             │ HTTPS, Authorization: Bearer <Supabase JWT>
             │ CORS: one exact origin, all methods enumerated (D-058)
             ▼
    ┌──────────────────┐        ┌──────────────────┐
    │ @asc/api         │        │ worker           │   SAME IMAGE (D-002)
    │ Fastify          │        │ pg-boss consumer │   different start command
    │ Railway          │        │ Railway          │   ASC_ROLE=worker
    └───┬────────┬─────┘        └────┬─────────┬───┘
        │        │                   │         │
        │        └─── enqueue ───────┤         │
        │             (pg-boss)      │         │
        ▼                            ▼         ▼
 ┌────────────────┐          ┌───────────────────────────┐
 │ @asc/shared    │          │ @asc/ai                   │
 │ PURE FUNCTIONS │          │ provider abstraction      │
 │ no I/O, no AI  │          │ limiter · backoff ·       │
 │ mastery        │          │ failover · generateJson   │
 │ selection      │          └──────────┬────────────────┘
 │ mistakes       │                     │
 │ recommend      │            ┌────────┴────────┐
 │ growth         │            ▼                 ▼
 │ facts          │      ┌──────────┐      ┌──────────┐
 │ progress       │      │ Groq     │      │ Gemini   │
 │ analytics      │      │ 120b/20b │      │ embed    │
 └────────────────┘      └──────────┘      └──────────┘
        │
        ▼
 ┌──────────────────────────────────────────────────────┐
 │ Supabase (single Postgres 17 instance)               │
 │  • 20 application tables, RLS on every one           │
 │  • 36 policies                                       │
 │  • pgvector 0.8.2, HNSW index, 768-dim embeddings    │
 │  • pg-boss queues in their own schema                │
 │  • Auth (JWT issuer)                                 │
 │  • Storage — private `materials` bucket              │
 └──────────────────────────────────────────────────────┘
```

**One Postgres for everything** — relational data, vector search and the job
queue. At prototype scale a separate vector database and a Redis would add two
failure modes, two deploy targets and two consistency problems to solve a
capacity problem this workload does not have. The cost is that a heavy indexing
run competes with queries on the same instance, which is documented rather than
pretended away.

**API and worker are the same container image** with different start commands
(D-002). One codebase, one build, no drift between what serves a request and
what processes a job.

---

## 2. Layers and what each may not do

| Package | Responsibility | The rule it obeys |
|---|---|---|
| [`packages/shared`](../packages/shared) | Domain types, zod schemas, **the deterministic learning core**, analytics aggregation | **No network, no database, no AI, no clock except one passed in.** Every export is a pure function |
| [`packages/ai`](../packages/ai) | Provider abstraction, token-bucket limiters, backoff with jitter, primary→fallback failover, `generateJson()` | Every call writes an `ai_requests` row. No exceptions — the recorder is inside the provider, not at the call sites |
| [`apps/api`](../apps/api) | Fastify routes, background jobs, retrieval, prompts, the evaluation harness | Learner reads go through the **caller's JWT**, and filter `user_id` explicitly as well (D-073) |
| [`apps/web`](../apps/web) | React SPA | Never trusts a client-side check for anything that matters. The admin link is rendered from a role the server returns, and the server re-reads that role from the database on every request (D-053) |

### The line that matters most

The PRD requires that mastery scoring, adaptive selection, repeated-mistake
detection and recommendation triggering be **backend logic, not an AI call**
(§9, §10, §13). That line is drawn at a package boundary, not by convention:

```
packages/shared/src/learning/     ← decides WHAT is true and WHAT to do
  mastery.ts      score updates, bands, confidence, staleness
  selection.ts    which concept, which difficulty, which question type
  mistakes.ts     repeated-mistake patterns and severity
  recommend.ts    whether to recommend at all, and about what
  growth.ts       improving / stable / needs attention
  facts.ts        which durable learner facts are relevant to this question
  progress.ts     where the learner is, and the next steps (D-075)

apps/api/src/lib/*.ts             ← turns those decisions into SENTENCES
```

A model writes the question's wording, the explanation, the feedback and the
recommendation sentence. It never chooses the concept, the difficulty, the score
or the next action. Every module above is unit-tested without mocking a
provider, and `journey.test.ts` drives all four through one learner's history
end to end.

---

## 3. Data model

20 tables. The spine is `auth.users → profiles → spaces → projects`, and
**every** child table carries both `project_id` and `user_id` — denormalised on
purpose, so an ownership filter is always one predicate away and a background
job never has to join three tables to prove who a row belongs to.

```
profiles ──┬── spaces ──── projects ──┬── materials ──── material_chunks (vector 768)
           │                          ├── concepts ─────┬── concept_mastery
           │                          │                 └── mastery_history
           │                          ├── conversations ─── messages (citations, mode)
           │                          ├── quiz_attempts ──── quiz_questions
           │                          ├── question_bank        (reusable generations only)
           │                          ├── learner_facts        (durable context)
           │                          ├── flashcards           (cards + review state)
           │                          ├── recommendations
           │                          └── learning_events      (the activity spine)
           └── ai_requests             (observability)

eval_runs ──── eval_results            (AI evaluation history)
```

**`learning_events` is the spine.** Analytics, streaks, the activity feed, the
recommendation triggers and the admin view are all arithmetic over that one
table, with idempotency keys so a retried job cannot double-count.

**`mastery_history` stores points, not a verdict.** Growth trend is *derived*
from the history on read rather than stored as a flag, so changing how growth is
judged re-reads the same evidence instead of losing it (D-049).

---

## 4. Request flows

### Tutor — the grounded path

```
question
  → classify intent (deterministic; D-075)
  → material path:
      embed query (Gemini)
      → pgvector match, 6 chunks, 1,600-token cap, relevance gate
      → not enough evidence?  → deterministic refusal, ZERO tokens spent
      → select relevant learner facts (pure fn, against the top chunk)
      → compose: system prompt + <sources> + history(4) + <question>
      → Groq 120b
      → hijack check → normalise [S#] markers → map markers to real chunks
      → grounded = at least one citation resolved
  → progress path (D-075):
      load state → buildStudyBrief (pure fn) → Groq 20b for wording only
      → reject the generation if it invents a number the brief does not contain
      → otherwise fall back to the brief's own rendering, which is a complete answer
```

### Material upload

```
POST /api/materials (multipart)
  → magic-byte check (not the client's Content-Type)
  → Storage: <user_id>/<project_id>/<id>.pdf, private bucket, no client INSERT policy
  → enqueue material.process with singletonKey
      worker → download → extract per page → chunk → embed (batched, paced)
             → upsert on (material_id, chunk_index), delete stale trailing chunks
             → enqueue material.concepts
  → status polling stops when nothing is pending
```

Idempotent by construction: re-processing the same material produces the same
chunks rather than duplicates, which is the PRD's "operations that may be retried
must avoid creating duplicate state".

### Quiz

```
start → buildCandidates (every concept, empty mastery included)
      → selectNextQuestion (need · uncertainty · mistakes · repetition)
      → selectDifficulty from the mastery estimate, NOT from the last answer
      → question_bank hit? reuse : generate (20b) → validate against zod → persist
answer → MCQ: integer compare (instant) | open: 20b grader → validated
       → updateMastery → mastery_history
       → /next fetched separately, so feedback never waits on generation (D-059)
complete → enqueue quiz.completed
           worker → detectRepeatedMistakes → write learner_facts
                  → evaluateTriggers → generate ONE recommendation sentence
```

### Flashcards

```
generate → buildCandidates (the quiz's own candidates)
         → selectDeckConcepts = scoreConcept, top N — the SAME ranking the quiz uses
         → retrieve ~3 chunks per concept → generate 3 cards (20b)
         → validate against zod → upsert on (project_id, front), duplicates ignored
review   → rating in, schedule out: reviewCard(schedule, rating, now), pure
         → written with the service role; a client-supplied dueAt/ease is ignored
         → learning_events only. Mastery is NOT touched (D-081): self-rated
           recall is not graded evidence
```

---

## 5. Security and isolation

Three deliberately overlapping layers:

1. **RLS on all 20 tables**, 36 policies. Child inserts assert ownership of the
   *parent* too, so a row carrying your own `user_id` but someone else's
   `project_id` is rejected.
2. **Explicit `user_id` filters on every learner-facing query** — 31 call sites.
   RLS is the backstop, not the statement of intent: `is_admin()` makes a policy
   match every row, which is exactly how an admin once saw other users' data on
   the learner pages (D-073). Admin-wide reads live under `/api/admin/*` and
   nowhere else.
3. **Background jobs carry ownership in the payload and filter on it**, because
   the worker uses the service role and bypasses RLS.

**Prompt injection is treated as a data-boundary problem, not a prompt problem.**
Material appears only inside numbered `<source>` blocks; the learner's own
question is contained in `<question>` (a loose question was obeyed once — D-037);
delimiters inside either are neutralised; and an output-side check catches the
case where the model complied anyway (D-035). Two evaluation cases exercise both
directions, run repeatedly, because compliance is probabilistic.

**Authorization is read from the database, never from a token claim.**
`profiles.role` is re-read on every request, so promoting or demoting an account
takes effect on the JWT already in the user's browser (D-053).

---

## 6. Major decisions, and what was rejected

| Decision | Rejected alternative | Why | Ref |
|---|---|---|---|
| One Postgres for relational + vector + queue | Pinecone/Qdrant + Redis | Two more services to deploy, monitor and keep consistent, to solve a scale problem a prototype does not have | D-001 |
| API and worker share one image | Two services, two builds | Drift between the code that serves and the code that processes is invisible until it bites | D-002 |
| Deterministic learning core in a pure package | "Ask the model what to study next" | A stated PRD criterion; also testable, reproducible, explainable and free | D-038 ff. |
| Validate every structured generation with zod before persisting | Trust JSON mode | Groq's JSON mode is not schema-locked. Concepts become the spine of mastery — a malformed one propagates everywhere | D-023 |
| Refusals are a deterministic template | Ask the model to decline politely | Costs zero tokens and cannot drift into a hedged non-answer that still sounds like an answer | — |
| Cache only reusable generations (`question_bank`) | Cache Tutor answers | A stored answer to a different free-text question is a correctness bug, not a performance win | — |
| Two model tiers with separate quota pools | One model everywhere | 8,000 TPM per *model* — grading and question wording must not starve the Tutor | D-016, D-062 |
| Growth trend derived from `mastery_history` on read | Store a trend flag | Changing the judgement re-reads the evidence instead of losing it | D-049 |
| Learner facts, selected per question | Send the whole transcript | The PRD's "persistent but relevant"; also the only affordable option at 8,000 TPM | D-050 |
| Progress questions answered from the record | Answer everything with RAG | A PDF cannot know how a learner is doing; retrieval could only answer by inventing them | D-075 |
| AI usage on Project Analytics and Admin, not on the learner's global view | Show it everywhere, or nowhere | §12 names it for a Project; §16 puts platform AI usage on the Admin Dashboard | D-077 |

---

## 7. What this architecture does not do

Stated plainly; the full list is in the README's Known Limitations.

- **No streaming.** Tutor answers arrive whole. Streaming is a PRD "Should
  Have"; the Must-Haves came first, and the groundedness check needs the
  completed text before citations can be shown.
- **No OCR.** A scanned PDF with no text layer extracts nothing. Text-layer PDFs
  only.
- **No tool-calling loop.** The PRD's §8 pattern — model requests an action, the
  backend validates and executes — is implemented as *application-orchestrated*
  structured generation: the application decides which capability to invoke, the
  model produces validated structured data for it, and the model never holds a
  handle to the database or to a privileged operation. This satisfies §8's actual
  requirement ("the AI should not have unrestricted access"; "AI-generated
  structured data should be validated before it is persisted") but does not
  implement an agentic loop. With more time, question generation and retrieval
  are the two capabilities worth exposing as real tools.
- **Single region.** `ap-south-1` for the database, US for the frontend and API.
  Fine for a prototype, wrong for real users.
