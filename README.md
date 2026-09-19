# AI Study Companion

An AI-powered learning workspace: add your own material, learn with a Tutor that
answers **only** from that material and cites it, test yourself with adaptive
quizzes, and watch concept mastery move as evidence accumulates.

| | |
|---|---|
| **Live app** | https://ai-study-companion-ruby.vercel.app |
| **API** | https://ai-study-companion-production-a07f.up.railway.app |
| **Stack** | React + TypeScript · Fastify + TypeScript · Supabase (Postgres 17, Auth, Storage) · pgvector · pg-boss |
| **Providers** | Groq (generation) · Gemini (embeddings) |

```
609 automated tests · 18 AI evaluation cases · a full production loop rehearsal
```

---

## Submitting / reviewing this project

| §20 deliverable | Where |
|---|---|
| Working application | [ai-study-companion-ruby.vercel.app](https://ai-study-companion-ruby.vercel.app) |
| Architecture documentation | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| AI usage — build-time vs product | [`docs/AI_USAGE.md`](docs/AI_USAGE.md) |
| Development prompts | [`docs/PROMPTS.md`](docs/PROMPTS.md) |
| Evaluation approach | [Evaluation](#evaluation) · [`apps/api/src/eval/`](apps/api/src/eval) |
| Known limitations | [Known limitations](#known-limitations) |
| Future improvements | [If there were more time](#if-there-were-more-time) |
| **Requirement-by-requirement coverage** | [`docs/PRD_COVERAGE.md`](docs/PRD_COVERAGE.md) |

**Reviewing against the PRD?** [`docs/PRD_COVERAGE.md`](docs/PRD_COVERAGE.md)
maps every Must Have to the file that implements it and the test that proves it,
and says plainly which single requirement is Partial and why.

---

## The idea

Most "AI study tools" are a chat box next to a file upload. The interesting
problem is not generating text — it is making a learning loop where each step
produces evidence the next step can use:

```
Space → Project → Material → Indexed knowledge → Tutor (grounded, cited)
  → Adaptive quiz → Graded answer → Concept mastery → Growth analysis
  → Recommended next action → back to the top
```

Two commitments shape almost every decision in this repo.

**The Tutor answers from your material or it declines.** There is no fallback to
what the model happens to know. A question the material does not cover produces
a refusal naming what is missing — and that refusal costs zero tokens, because
it is a deterministic template rather than a model asked to improvise humility.

**The teaching decisions are code, not prompts.** Which concept to test, at what
difficulty, whether you have a repeated-mistake pattern, whether to recommend
anything at all — all of it is pure functions in `packages/shared/src/learning/`,
tested without a provider. The model writes the *words*: the question's wording,
the explanation, the feedback sentence. It never decides what you should study.

---

## Quick start

**Prerequisites:** Node 22+, a Supabase project, a [Groq API key](https://console.groq.com/keys),
a [Gemini API key](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/sunkaramahesh09/ai-study-companion.git
cd ai-study-companion
npm install                      # npm workspaces; no pnpm needed

cp .env.example .env             # then fill it in — every variable is documented there
```

Apply the migrations in `supabase/migrations/` in numerical order (Supabase SQL
editor, or `supabase db push`). They create 20 tables, 36 RLS policies, the
pgvector index and the storage bucket.

```bash
# Start the worker FIRST and give it a moment to register its handlers,
# otherwise the first upload sits in `queued` until you restart it.
node --env-file=.env apps/api/src/worker.ts &
sleep 3
node --env-file=.env apps/api/src/server.ts &
npm run dev:web                  # http://localhost:5173
```

> **If you share `DATABASE_URL` with a deployed environment, set
> `PGBOSS_SCHEMA=pgboss_dev`.** Otherwise your local worker competes with the
> deployed one for the same jobs, and which *version of the code* processes a
> document becomes a coin flip. This produced results alternating between
> "25 chunks embedded" and "0 chunks embedded" with no code change (D-031).

### Commands

| Command | What it does |
|---|---|
| `npm test` | 609 tests across 46 files. **Set the env vars** — integration tests skip silently without them |
| `npm run typecheck` | All four workspaces |
| `npm run build` | Builds everything; the web build **fails** if `VITE_*` is missing (see below) |
| `npm run eval` | 18 AI evaluation cases against real models (~4 min, spends quota) |
| `npm run eval <suite>` | One of `tutor`, `retrieval`, `assessment`, `recommendation`, `security` |
| `npm run eval -- --list` | Every case and what it protects |
| `npm run rehearse` | Drives the entire loop against **production** with a fresh account |

Run the live tests with `node --env-file=.env ./node_modules/.bin/vitest run` —
a bare `npx vitest run` silently skips every test that needs a key, and a green
result then means much less than it looks like.

---

## Architecture

```
 Vercel                    Railway                          Supabase
┌────────────┐            ┌─────────────┐ ┌─────────────┐  ┌──────────────────┐
│ @asc/web   │            │ @asc/api    │ │ worker      │  │ Postgres 17      │
│ React 19   │──HTTPS────▶│ Fastify     │ │ pg-boss     │  │ • 20 tables      │
│ SPA        │   (JWT)    │             │ │             │  │ • 36 RLS policies│
└────────────┘            └──────┬──────┘ └──────┬──────┘  │ • pgvector HNSW  │
       │                         │               │         │ • Auth           │
       └── supabase-js (auth) ───┼───────────────┼────────▶│ • Storage        │
                                 └───────────────┴────────▶└──────────────────┘
                                         │
                                 ┌───────┴────────┐
                                 │ @asc/ai        │
                                 │ Groq · Gemini  │
                                 └────────────────┘
```

`api` and `worker` are the **same container image** with different start
commands — one codebase, one deploy, no drift between the two (D-002).

### Workspaces

| Package | Contains | Rule it obeys |
|---|---|---|
| `packages/shared` | Domain types, zod schemas, the deterministic learning core, analytics aggregation | **No network, no database, no AI.** Everything is a pure function, so the logic the PRD requires to be deterministic is testable without mocking a provider |
| `packages/ai` | Provider abstraction, token-bucket limiters, backoff, failover, `generateJson()` | Every call writes an `ai_requests` row — no exceptions |
| `apps/api` | Fastify routes, jobs, retrieval, prompts, the evaluation suite | Reads go through the **caller's JWT** so Postgres enforces isolation |
| `apps/web` | React SPA | Never trusts a client-side check for anything that matters |

### How data stays isolated

Three layers, deliberately overlapping:

1. **Postgres RLS** on every table, keyed to `auth.uid()`. This is the real
   boundary.
2. **The API queries with the caller's own JWT**, not a service-role key — so
   the database enforces scope on every query rather than the route handler
   remembering to. Even the admin routes work this way: the RLS policies widen
   for an admin via `is_admin()`. A route that forgets its auth preHandler then
   leaks the caller's own rows, not everyone's (D-053).
3. **The worker has no caller**, so it uses the service role and carries
   ownership *in the job payload*, filtering on it explicitly. A forged payload
   finds nothing.

Admin role is read from `profiles.role` **in the database** on every request,
never from a JWT claim. Proven by a test that promotes a user mid-session and
reuses the token issued *before* the promotion.

---

## AI engineering

### Two providers, two roles

| Role | Provider | Models | Why |
|---|---|---|---|
| Generation | Groq | `openai/gpt-oss-120b` primary, `openai/gpt-oss-20b` fallback | Grounded answers get the better model; short high-volume work (single-question generation, single-answer grading) uses the fallback tier and its **separate quota pool** |
| Embeddings | Gemini | `gemini-embedding-001` @ 768 dims | Free tier; 768 keeps vectors inside pgvector's index limit (D-004) |

**TPM is the binding constraint, not RPM.** 8000 tokens/minute with a Tutor
answer costing ~3000 means roughly two answers a minute. Almost every
performance decision here follows from that number: retrieval is capped at six
chunks and 1600 tokens, only the four most recent conversation turns are sent,
learner context is filtered for relevance rather than pasted wholesale, and the
evaluation suite runs sequentially because parallelism would only buy backoff.

The limiter **waits** rather than failing, which is why the frontend allows 150
seconds for a request that sits behind a model and 30 for everything else.

### Structured output is never trusted

Groq's JSON mode is not schema-locked. So `generateJson()` requests JSON mode,
puts the schema in the prompt, and then **validates the parsed result with zod
before returning it**, with one repair attempt and then a hard failure. Nothing
reaches the database or changes application state on the strength of the API
saying it produced JSON.

This matters most in grading: a fabricated score writes straight into mastery,
permanently and silently. `sanitiseGrade()` therefore checks the grade for
*coherence*, not just schema shape.

### Prompt injection: three layers

Learning material and user messages are **data**, never instructions.

1. **Structural** — retrieved chunks are wrapped in delimited blocks with their
   own delimiters neutralised; the learner's question is contained the same way.
2. **Instructional** — the system prompt states the data/instruction boundary
   explicitly and refuses to reveal itself.
3. **Output-side** — `looksHijacked()` inspects the answer. A hijacked answer
   triggers one retry with an explicit notice; if that also complies, the answer
   is discarded rather than shown.

Layer 3 exists because layers 1 and 2 are *probabilistic*. Where model
compliance cannot be guaranteed, pair the instruction with a mechanism that does
not depend on it.

There is an adversarial PDF fixture in the repo, and the evaluation suite runs
the injection case three times per run precisely because a single clean pass
proves little.

### Two kinds of question, two sources of truth

A question about the *material* goes to retrieval and is answered with citations
back to a page. A question about the *learner* — "where was I, how am I doing,
what should I do next?" — is answered from their own record: concept mastery,
quiz history, repeated mistakes, the active recommendation.

Routing between them is deterministic, and the split exists because sending the
second kind to retrieval produced a confident, cited fabrication — the model read
the document's contents page and reported it back as the pages the learner had
visited. Nothing records what anyone has read. `buildStudyBrief` computes where
the learner stands and what to do next; the model only words it, and a generation
that quotes a number the brief does not contain is discarded in favour of the
brief's own rendering (D-075).

### Observability

Every provider call writes an `ai_requests` row: feature, model, status,
latency, tokens, estimated cost, attempt count, whether it failed over. That is
what makes the PRD's questions answerable — why was it slow, which model, what
did it cost, which workflow failed — and it is what the admin dashboard reads.

Latency is reported over **successful** requests only: a call that 429'd through
four backoff waits is slow in a way that says nothing about model speed, and
mixing the two makes both numbers unreadable.

---

## Evaluation

```bash
npm run eval
```

18 curated cases across the five AI experiences, scored against a **four-page
document written for the purpose** with recorded ground truth — question → the
page the answer is actually printed on.

That last part is the whole design. Against borrowed material, a plausible
citation and a correct one are indistinguishable, so the suite would report
green while measuring nothing. Knowing the ground truth exactly is what makes
"groundedness" a measurement instead of a vibe.

| Suite | Cases | What it protects |
|---|---|---|
| `retrieval` | 4 | The right page comes back; off-topic queries return nothing; empty-because-unindexed is distinguished from empty-because-irrelevant |
| `tutor` | 3 | Citations point at the page the fact is on; refusal instead of fabrication; a refusal costs no tokens |
| `assessment` | 4 | Structured output survives real validation; grading ranks a good answer above a bad one; an answer that tries to grade itself is ignored; adaptivity reads mastery, not the last answer |
| `recommendation` | 3 | The right rule fires for the learner state; a healthy learner is never shown a weakness alert; the sentence leaks no internal field names |
| `security` | 3 | Injection in the material is not obeyed (3 runs); injection in the question is not obeyed; project isolation holds under retrieval |

Grading is **rule-based, not model-based**. A model judging another model's
citation costs tokens, adds variance, and is less trustworthy than checking a
page number against a known layout.

Results persist to `eval_runs` / `eval_results` **with the git sha**, and the
admin Evaluation tab renders them. `finished_at` is written last, so a crashed
run reports "did not finish" rather than presenting partial numbers as a result.
The command exits non-zero on failure, so it can gate a deploy.

### Verifying the deployment, not the repository

```bash
npm run rehearse
```

Every integration test in this repo builds the API **in-process**. That proves
the code is right and says nothing about whether the deployed container runs
that code, whether the worker process is alive, or whether CORS holds. The
rehearsal signs up a fresh account on the **live** stack and walks the whole
loop, then deletes it.

It has already earned its place twice. It caught the Tutor emitting `【S1】`
(fullwidth brackets) — parsed correctly, so no test failed, but the learner
reads the raw text and mixed bracket styles look like a product bug. Then, on
the very next run, it caught the *evaluation code itself* failing a perfectly
correct answer because the model wrote "thirty‑two" with a non-breaking hyphen.
A brittle literal match there produces a red result for working behaviour, in
the one place whose whole job is to be believed.

---

## Documentation

| Document | What is in it |
|---|---|
| [`docs/PRD_COVERAGE.md`](docs/PRD_COVERAGE.md) | **Every PRD Must Have mapped to the code that implements it and the test that proves it.** Start here if you are checking the build against the requirements |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System diagram, layer boundaries, data model, request flows, and the major decisions with what was rejected |
| [`docs/AI_USAGE.md`](docs/AI_USAGE.md) | AI used to **build** the product vs AI used **by** the product, kept strictly apart |
| [`docs/PROMPTS.md`](docs/PROMPTS.md) | The actual development prompts, recovered from the session transcripts rather than written from memory |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **88 numbered decisions**, each with the alternative rejected and why. Written as the work happened, not reconstructed. Code comments cite them by id (`// see D-005`) |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deploying the three services, and the configuration mistakes that fail silently |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | The shot list the submission video was recorded from, mapped to the PRD §20.2 order |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Build state, task checklist, and a landmine list |
| [`.env.example`](.env.example) | Every variable, what it is for, and which ones must never reach the browser |

`DECISIONS.md` is the most useful file here for understanding *why* anything is
the way it is. A few worth reading on their own:

- **D-029** — a relevance threshold documented as "measured" that had never been
  measured. The real numbers put every off-topic query inside the gate.
- **D-038** — mastery moves by *surprise*, not by correctness, and staleness
  discounts the *evidence* rather than the score.
- **D-052** — the web build shipped a bundle containing **no application code**
  for most of this project's life, and reported success every time.
- **D-053** — why admin routes use the caller's JWT instead of the service role.
- **D-058** — CORS advertised only `GET,HEAD,POST`, so every edit and delete in
  the app was dead in the browser. Nothing caught it: CORS is enforced by the
  browser, and the rehearsal only asserted that a *bad* origin is rejected. A
  negative CORS assertion is not a positive one.
- **D-060** — the client set `Content-Type: application/json` on every request,
  so every body-less POST was rejected by Fastify's body parser before reaching
  the route. The material Retry button had never worked.

---

## Known limitations

Stated plainly, because a prototype that pretends otherwise is worse than one
that does not.

- **Growth trend is lifetime, not recent.** `delta` compares the first and last
  points in the retained window, so a learner who climbed and then slipped reads
  as "improving". A proper fix compares a recent segment against what preceded
  it, which needs more history than a four-day build produces to tune honestly
  (D-049).
- **Leaked-password protection is off, because the plan does not offer it.**
  Supabase Auth can reject passwords known to HaveIBeenPwned, and its security
  advisor flags the project for having it disabled. The feature is **Pro plan and
  above**; this project runs on Free, so the toggle is not available to enable.
  What *is* available on Free — minimum length and required character classes —
  is configured. The advisor's other two findings are deliberate: the mutable
  `search_path` functions are pg-boss's own, and `is_admin()`, `owns_project()`
  and `owns_space()` are `SECURITY DEFINER` by design, each answering only about
  the caller, which is what makes them safe to expose to `authenticated` (D-087).
- **18 evaluation cases is a floor, not a comprehensive suite.** Notably absent:
  multi-turn Tutor coherence, grading consistency across repeated runs of the
  same answer, and retrieval quality on a document large enough for chunk
  boundaries to matter (D-054).
- **One theme, and it is light.** There is no dark mode and no theme toggle;
  `--bg-page` is `#faf9ff`. The chart palette in D-051 was originally stepped
  against a dark surface, and when the UI moved to the light lavender treatment
  the ramps were re-tuned by eye rather than re-validated with the contrast
  measurements that produced the original numbers. Adding a dark theme is not a
  colour flip — it needs the ramps re-stepped and re-measured.
- **Green and red sit at deutan ΔE 7.9**, below the ΔE 8 separation target. New
  charts are single-series so identity never rests on colour; where the pair
  does appear it carries a text label (D-051).
- **PDF only.** No DOCX, no plain text, no URLs. A scanned PDF with no text
  layer extracts nothing — there is no OCR step.
- **No agentic tool-calling loop.** Structured AI interaction is
  application-orchestrated: the app chooses the capability, the model returns
  structured data, and that data is validated against a zod schema before it can
  persist or change state. This meets PRD §8's stated requirements but is not
  the tool-request pattern its diagram sketches. Called out honestly in
  [`docs/PRD_COVERAGE.md`](docs/PRD_COVERAGE.md).
- **Three Supabase security-advisor warnings remain, all understood.**
  `is_admin()`, `owns_project()` and `owns_space()` are `SECURITY DEFINER` and
  callable over RPC by signed-in users — they have to be, because the RLS
  policies that call them execute as the caller, and each only answers a
  question about *you* (do you own this row, are you an admin), so there is no
  information to gain. The ten `search_path` warnings are all pg-boss's own
  functions; ours were hardened in migration `0005`. Leaked-password protection
  is a Supabase Auth toggle that is currently off.
- **Unindexed foreign keys on `user_id` columns** (23, per the performance
  advisor). Hot paths are covered by the composite and `project_id` indexes;
  at prototype volume this is an INFO-level finding, not a latency problem.
- **The Tutor does not stream.** Answers arrive whole. Streaming is in the PRD's
  "Should Have", and the Must-Haves came first.
- **Open-ended answers still take a few seconds to grade**, because grading one
  genuinely requires a model call. Multiple-choice grading is instant. What was
  fixed (D-059) is that neither now waits on generating the *next* question.
- **Flashcards are new and have not been clicked through in a browser.** The
  API is covered by 17 route tests plus 4 live-generation tests, and the
  scheduler by 17 unit tests, but the page itself has only been typechecked and
  built. It is the newest surface in the app and the least exercised by hand.
- **A flashcard rating does not move mastery, on purpose** (D-081). Self-rated
  recall is not graded evidence, and mixing the two would corrupt the signal
  every adaptive decision depends on. It means a learner who only uses
  flashcards sees their activity rise and their mastery stay still — correct,
  but worth knowing.
- **Live-model tests occasionally flake** on content assertions. Deterministic
  assertions — what the server *chose* to send — are preferred where possible;
  see `learnerContext.test.ts`, which asserts on `factsUsed` rather than on
  phrasing.

## If there were more time

- Compare a recent window against the preceding one for growth trends.
- Multi-turn Tutor evaluation, and grading-consistency runs over the same answer.
- Stream Tutor answers; the groundedness check would need to run on the
  completed text before citations are shown.
- A larger, more adversarial evaluation corpus, with per-case history charted
  across git shas — the data model already supports it, the UI does not yet.

---

## License

Built as a technical evaluation exercise.
