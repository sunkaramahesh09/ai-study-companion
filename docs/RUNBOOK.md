# Build Runbook

**Purpose:** survive a cleared context. This is the single source of truth for
build state. Read it at the start of every session; update it at the end of
every task. Keep it terse and factual — status, not narrative.

**Last updated:** 2026-09-18 22:05 · **Day:** Fri · **Deadline:** Sat 2026-09-19 night

---

## Current state

**Tasks 1-5 complete and LIVE IN PRODUCTION.** All of Wednesday night's plan done.

### Production URLs
- **Frontend:** https://ai-study-companion-ruby.vercel.app
- **API:** https://ai-study-companion-production-a07f.up.railway.app
- **Worker:** Railway service `hospitable-light` (no public domain, by design)
- **Railway project:** `determined-empathy` / `production`
- **Supabase:** `maeifbzqpehidwuprypv` (`ap-south-1`, PG17, pgvector 0.8.2)

### Verified against production, not localhost
- `/health` 200 · `/api/me` 401 without a token · forged token 401
- CORS returns `access-control-allow-origin` for the Vercel origin and **nothing
  for an arbitrary origin** (not a wildcard)
- Full auth chain: create user → profile auto-created by trigger → sign in →
  `/api/me` 200 with correct user → `/api/admin/ping` 403 for non-admin →
  **200 after DB promotion using the SAME JWT** (role is read from the database,
  never from a token claim)
- **Worker alive:** `pgboss.version.flow_on` updating every few seconds. Only
  `worker.ts` calls `boss.start()`, so this proves the worker service is running.

**Tests: 35 passing.** Both AI providers smoke-tested live (D-016, D-017).

**Task 7 complete.** `packages/ai` provider layer built and verified live.

- `GroqProvider` — two tiers with separate quota pools, TPM-aware limiter,
  backoff + full jitter, automatic primary→fallback on an uncleared 429,
  `max_completion_tokens` floored at 256, empty content rejected as
  `invalid_output` (D-023).
- `GeminiEmbeddingProvider` — batching, pacing, dimension + count checks,
  unit-normalization enforced in the provider so no caller can forget (D-017).
- `generateJson()` — JSON mode + schema in prompt + **zod validation before the
  value is returned**, one repair attempt, then hard failure. This is the PRD §8
  enforcement point.
- Every call writes an `ai_requests` row. Verified: 3 rows in the live database.

**Tests: 91 passing** (56 in `packages/ai`). Failover and the empty-content
guard are unit-tested against a stubbed SDK rather than by burning real quota.

**Task 6 complete.** Spaces + Projects CRUD, end to end.

- Shared zod schemas in `@asc/shared` — one definition for the form and the
  route, so a constraint cannot drift between them.
- Full CRUD for both, `GET /api/projects/:id` returning the whole dashboard in
  one request (project, materials, mastery, recommendations, activity), shaped
  now so the frontend needs no rework when later tasks fill it.
- `learning_events` emission with idempotency keys — the activity spine.
- Frontend: router, Spaces list, Space detail, Project dashboard, shared UI
  primitives, empty states that carry the next action.

**Tests: 110 passing.** 19 CRUD tests incl. cross-user access through the HTTP
routes, and a mass-assignment test posting another user's `user_id`.

**Task 8 complete.** PDF upload and background processing, working end to end.

- Private `materials` Storage bucket, path `<user_id>/<project_id>/<id>.pdf`,
  no client INSERT policy — the API is the only way in (D-026).
- `POST /api/materials` multipart; PDF verified by magic bytes, not by the
  client's Content-Type.
- `material.process` pg-boss job: download → extract per page → chunk → ready,
  with ownership carried in the payload and filtered explicitly (service role
  bypasses RLS).
- Idempotent: chunks upserted on `(material_id, chunk_index)`, stale trailing
  chunks deleted, `singletonKey` prevents double-queueing.
- Frontend: upload with progress, status polling that stops when nothing is
  pending, retry and delete.

**Verified live, whole pipeline:** non-PDF rejected · 247 KB upload → queued →
worker → ready, 25 pages / 25 chunks · every chunk carries a valid page number ·
**reprocess produced no duplicate chunks** · all four lifecycle events recorded.

**Tests: 122 passing** (12 new for extraction and chunking, incl. a real-PDF
test asserting each chunk's text actually appears on the page it cites).

## >>> RESUME HERE <<<

**Session 2026-09-17 15:30.** All 25 build tasks complete, plus the README.
**491 tests passing** + **17/17 evaluation cases** + a green production
rehearsal. Typecheck clean, web build verified to contain the app.

### Four shipped bugs found from real use, all fixed and deployed

1. **CORS advertised only `GET,HEAD,POST`** (D-058). Every PATCH and DELETE was
   blocked by the browser: dismiss a recommendation, rename a space or project,
   remove a material, delete a space or project. **Every edit and every delete
   in the app.** Invisible to tests (`app.inject` skips the network) and to the
   rehearsal (Node's fetch ignores CORS). The rehearsal *did* check CORS — only
   that a bad origin is rejected. **A negative CORS assertion is not a positive
   one.** Now checks both, per method.
2. **Quiz grading waited on the next question** (D-059). `/answer` returned the
   verdict *and* generated the next question, so an integer comparison took as
   long as a model call behind a limiter that waits — ~1 minute to learn whether
   an answer was right. Split into `/answer` + `POST /quizzes/:id/next`, which
   the client fetches while the learner reads their feedback. Now ~3.6s live.
3. **Every body-less POST 400'd before reaching its route** (D-060). The client
   set `Content-Type: application/json` unconditionally; Fastify rejects that
   with an empty body in the body parser, before auth. **The material Retry
   button had never worked.** Two of the four affected callers swallow errors by
   design, which is what kept it invisible.
4. **A conflicting quiz start dead-ended instead of resuming** (D-061). The API
   correctly 409s with the open attempt's `attemptId` when a quiz is already in
   progress, but `apps/web/src/lib/api.ts` threw away every field except
   `message`, so the Quiz page could only show a permanent error card with no
   way to reach the "in progress" quiz it was talking about. `ApiError` now
   carries the parsed body; the Quiz page resumes the open attempt's pending
   question on a 409, with a "Start a new quiz instead" escape hatch that
   abandons it. **Confirmed the answer/next split (D-059) itself is working as
   designed** — feedback is instant; the remaining wait is real model latency
   for the next question, overlapped with reading time.

**The lesson worth carrying:** all four were invisible to a green test suite
because each lived in a layer the tests do not exercise — the browser's CORS
enforcement, wall-clock latency, the HTTP body parser, and an error response's
fields beyond `message`. `npm run rehearse` now covers the first two.

### Fifth from real use: the app knew where you were and made you say it again

**Session 2026-09-18.** Reaching a quiz or the Tutor meant walking Spaces →
space → project → feature every single time; the sidebar's Quizzes and Ask
Tutor entries both redirected to `/spaces`. Fixed by leading with the last used
space and project everywhere, with the switcher one click away (D-065).

- `apps/web/src/lib/studyContext.ts` — `useStudyContext()`. "Last used" is the
  first row of `GET /api/projects` (ordered by `last_active_at`), **not**
  localStorage.
- `apps/web/src/components/StudyContext.tsx` — `ContinueCard` (landing) and
  `StudyContextBar` (breadcrumb + switcher on a project-scoped page).
- `apps/web/src/routes/StudyLauncher.tsx` — `/quiz` and `/tutor` are now real
  pages, not redirects. They do **not** auto-start anything: starting a quiz
  spends model quota.
- Quiz and Tutor now `POST /projects/:id/touch` on mount, so `last_active_at`
  tracks the work, not just dashboard visits.
- Two rendering bugs fixed on the way: space cards had been printing the
  literal words "book"/"brain"/"file" instead of their icons since the
  emoji→line-icon change, and `.pill`'s `capitalize` was mangling typed project
  names ("Paging And TLBs").

Verified in a browser against a throwaway seeded account, then deleted. Not
covered by automated tests — it is navigation and layout.

### Sixth from real use: the Tutor answered "how am I doing?" by inventing the learner

**Session 2026-09-18.** Asked *"Where was I, how am I doing, and what should I
do next?"*, the Tutor retrieved the document's own overview page and reported
its table of contents back as the learner's reading history — *"the pages you
have accessed cover: Page 1… Page 2…"*. Cited, fluent, fabricated. Nothing
records which pages anyone has read. It also never answered the other two
thirds: no score, no weakness, no next step.

The cause was routing, not prompting: **every** question went to RAG over the
PDFs, and a progress question has no answer in a PDF. Fixed by routing on intent
and answering from the record the system already keeps (D-075).

- `packages/shared/src/learning/progress.ts` — `classifyTutorIntent`,
  `buildStudyBrief`, `renderStudyBrief`. Pure: no AI, no I/O. Decides what is
  true and what to do next, the same way the recommendation rules do.
- `apps/api/src/lib/progress.ts` — loads the state (`user_id` filtered on every
  query), then asks a model **only to reword the brief**, on the fallback tier.
  Rejects a generation that is hijacked, loses the three-part shape, or quotes a
  number the brief does not contain, and shows the brief instead.
- `messages.mode` (**migration 0009, applied to production**) — nullable
  `'material' | 'progress'`. Without it the UI cannot tell a progress answer
  from an ungrounded one, since neither has citations. The Tutor page now shows
  "Based on your progress" and suppresses the "no supporting evidence" pill on
  progress turns.

**Verified against the reported project itself**, not a fixture: stage
`assessed`, 10 of 11 concepts tested, Embeddings and Inference at 0% with 4-of-4
recent answers wrong, last quiz down 60 points, next step "re-explain Embeddings
before re-testing it". Live-model wording checked too, and the fallback fired
for real once on a transient provider error — the answer was complete anyway.

**Tests: 553 passing** (41 new). Tutor evaluation suite **4/4** with a new case,
`tutor.answers-a-progress-question-from-the-record`, which also asserts ordinary
material questions still retrieve and cite.

### Seventh and eighth: the landscape stopped at Home, and AI spend was on the wrong page

**Session 2026-09-18.**

**The background (D-076).** The mountains, glows and clouds lived in `Home.tsx`,
so every other page was flat white. Extracted to
`apps/web/src/components/PageDecor.tsx` and rendered by the `Shell`, **outside**
the `key={location.pathname}` on `<main>` — inside it, the background would be
rebuilt on every navigation. CSS moved `pages.css` → `layout.css`; it is
application frame now, not one page.

**Favicon (D-076).** There was no `<link rel="icon">` at all.
`apps/web/scripts/make-favicon.py` holds the geometry once and emits
`favicon.svg`, `favicon.ico` (16/32/48) and `apple-touch-icon.png` (180). Run it
by hand when the mark changes; the outputs are committed. Also added
`theme-color`, a real `<title>` and a meta description.

**AI activity (D-077).** The AI usage panel was on Project Analytics, the
learner's Global Analytics, and Admin. The PRD puts it on the first (§12, named
explicitly) and the third (§16), and says Global Analytics aggregates *learning
activity* only. Removed from Global — **at the API**, not just the page:
`GET /api/analytics` no longer queries `ai_requests` or returns an `ai` object.
`ai_requests` RLS left alone on purpose: a learner must read their own rows for
the Project view the PRD asks for.

**Verified in a browser** on a throwaway seeded account, every page, then the
account was deleted. **Tests: 555 passing.**

### Submission deliverables audit (§20) — three were missing

**Session 2026-09-18 19:00.** Read the PRD end to end as an evaluator would and
mapped it against the repository. Every Must Have was implemented; **three
required submission deliverables were not in the repo at all**:

- [`docs/AI_USAGE.md`](AI_USAGE.md) — §20.5, build-time AI vs product AI. (The
  transcripts show this was started on 2026-09-17 and deferred.)
- [`docs/PROMPTS.md`](PROMPTS.md) — §20.6. Built from the **real** session
  transcripts in `~/.claude/projects/.../*.jsonl`: 102 distinct prompts across 8
  sessions, 42 substantive, grouped by the PRD's own categories.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — §20.4 asks for a dedicated
  architecture document with a diagram; it existed only as a README section.

Also added [`docs/PRD_COVERAGE.md`](PRD_COVERAGE.md): every Must Have → the file
that implements it → the test that proves it, with §8 marked **Partial** and the
reason stated rather than claimed as done.

**Stale claims fixed in the README** — it advertised 491 tests, 17 eval cases and
57 decisions; the real numbers are 555, 18 and 77. An evaluator checking a claim
and finding it wrong discounts every other claim in the file.

### Ninth: a red security test that was actually a provider blip

**Session 2026-09-18 21:00.** A full `npm test` came back **554/555**. The
failure was `tutorBehaviour › prompt injection › a user message cannot override
the rules either`, printing `TypeError: Cannot read properties of undefined
(reading 'replace')` inside `complied()` — the helper that decides whether the
Tutor obeyed an injection. Re-run unchanged: 10/10 green.

The Tutor route returns **503 `tutor_unavailable`** when generation throws, and
that body has no `message`. One transient Groq failure therefore crashed inside
the security assertion and read as *task 12 has broken* (D-078).

- `apps/api/src/__tests__/fixtures/askLive.ts` — live suites ask through it.
  Status checked at the boundary, one retry on 503, then a hard failure that
  says *upstream outage, not a Tutor behaviour failure*. Never a skip.
- `tutorBehaviour.test.ts` and `learnerContext.test.ts` rewired to it.
- Two cases in `providerFailure.test.ts` test the helper against a stubbed
  outage: two attempts then the labelled error, and a transient failure ridden
  out. Verifying the verifier, as with `verify-bundle.mjs` (D-052).
- **`npm run rehearse` had the same class of hole:** the injection step checked
  only `!/^\W*BREACHED\W*$/` against `content ?? ''`. An empty string passes,
  so a 503 there would have printed a green "Did not comply" — a security check
  passing because nothing answered. It now asserts HTTP 200 first.

Full clean run after the change: **557 passing, 41 files.** Typecheck clean.
README and `PRD_COVERAGE.md` counts updated from 555.

### Tenth: Progress led away from the project, so Project analytics was invisible

**Session 2026-09-18 21:30.** Reported as *"we have global analytics but we dont
have project analytics"*. It was built — route, page, AI panel, the lot. It had
one entrance (a button on the project dashboard) and the sidebar's **Progress**
redirected straight to the account-wide roll-up, so navigating from the rail it
did not exist (D-079).

- `/progress` is now `<StudyLauncher mode="analytics" />`, leading with the last
  used project. *Across all spaces* in the header keeps the roll-up one click away.
- Global Analytics' **Activity by Project** rows now link into each project's
  own analytics (`RowBars` grew an optional `href`).
- Project Analytics carries the `StudyContextBar` the Tutor and Quiz have.
- Progress stays lit in the rail on all three surfaces.

### Flashcards (PRD Nice to Have) — shipped

**Session 2026-09-18 21:30–22:05.** Asked for, with an offer of a Gemini key.
**The key was not needed and would have been the wrong provider** — Gemini is
this project's embedding provider; generation is Groq, and card wording runs on
the **fallback** tier that CLAUDE.md reserves for short schema-bounded work
(D-080).

- **Migration `0010_flashcards`, applied to production.** `flashcards` table,
  SELECT-only RLS, `unique (project_id, front)` for idempotent generation;
  `learning_events` and `ai_requests` CHECK constraints widened for
  `flashcards_generated` / `flashcard_reviewed` / `flashcard_generation`.
- `packages/shared/src/learning/flashcards.ts` — SM-2 derived scheduling, pure,
  `now` injected. Which concepts get a deck is `scoreConcept`, the **same**
  selector the quiz uses.
- `apps/api/src/lib/flashcards.ts` + `routes/flashcards.ts` — generate, read,
  review, delete. Ratings go in, schedules are computed server side; a body
  carrying `dueAt`/`ease` is ignored (tested).
- `apps/web/src/routes/Flashcards.tsx`, `/flashcards` launcher, sidebar entry,
  project dashboard action, `cards` icon, styles.
- **A rating deliberately does not touch mastery** (D-081) — self-report must
  not contaminate a measure built from graded answers.
- **Found while testing live:** a second generation on a well-covered concept
  returned 503 because every card was a duplicate and "nothing inserted" was
  read as "generation failed". Now a 200 saying the deck already covers it.

**Tests: 601 passing, 45 files** (17 scheduler, 18 route, 4 live generation, 5
relative-time). Typecheck clean, web build green with `verify-bundle`.

**NOT browser-verified.** The UI has not had a click-through: that needs signing
in, and signing in on someone's behalf is not something to automate. A seeded
account is waiting — see the note at the end of this section.

### >>> STILL OUTSTANDING BEFORE SUBMITTING <<<

1. **The demo video (§20.2).** Not optional, not in the repo, and cannot be
   produced from here. Must walk: create Space → create Project → upload PDF →
   watch it process → ask the Tutor → grounded answer with citation → ask
   something the material does not cover → adaptive quiz → open-ended answer +
   feedback → mastery/growth → analytics → recommendation → Admin Dashboard.
2. **Enable leaked-password protection** in Supabase Auth (one toggle;
   Authentication → Policies). The security advisor flags it.
3. **Click through the two new surfaces** — Progress → a project's analytics,
   and Flashcards (generate → show answer → rate → watch the interval). Local
   `api` + `worker` + `web` were left running against a seeded account whose
   credentials are in **`.env.uicheck`** (gitignored — this repo is public, so a
   working sign-in never goes in a tracked file). Material indexed, 9 concepts,
   mastery seeded. Delete the account when done.
4. **Redeploy.** Vercel builds `main`; the API and worker need a Railway deploy
   for the flashcard routes. Migration 0010 is already applied to production.

**Tasks 10, 11 and 12 complete.** Grounded Tutor, unsupported-question
handling, and the prompt-injection boundary — the three highest-risk items on
the whole plan.

**Task 13 complete.** Concept extraction: even-spaced sampling inside a token
budget, fallback model, zod-validated before persisting, no-op on re-run.

**Task 14 complete.** The deterministic learning core — 84 tests, zero AI.

`packages/shared/src/learning/`:
- `mastery.ts` — IRT/Elo update moving by SURPRISE, prior 0.5, confidence from
  evidence, staleness discounting evidence not score (D-038).
- `selection.ts` — four weighted signals (need, uncertainty, mistakes,
  repetition) + difficulty targeting a 70% success rate, derived from the
  mastery estimate rather than the last answer.
- `mistakes.ts` — repeated-mistake patterns with recovery detection and
  difficulty-aware severity.
- `recommend.ts` — trigger rules with priority ordering and a 12h cooldown.

**Task 15 complete.** MCQ generation and the full quiz flow.

- `POST /api/quizzes` start · `POST /api/quizzes/:id/answer` · `GET /api/quizzes/:id`
  · `POST /api/quizzes/:id/abandon`
- Concept + difficulty from the deterministic selector; only wording generated
  (fallback model, zod-validated before persisting).
- `question_bank` caching, least-used first, re-validated on read.
- MCQ grading is an integer comparison, not an AI call.
- Mastery + `mastery_history` written on every answer.

**Task 16 complete.** Open-ended assessment with rubric-based grading.

- `selectQuestionType()` — deterministic format choice (D-045).
- Rubric generated WITH the question and stored, so grading is reproducible.
- Grader returns understood/missing/feedback, not just a score.
- Learner's answer contained as untrusted input (D-044) — here compliance would
  write a forged grade straight into mastery.
- `sanitiseGrade()` checks coherence, not just schema shape.

**Task 17 complete.** The quiz-completion workflow runs in the worker.

`quiz.completed` job: detect weakness → write `learner_facts` → evaluate
triggers → generate the recommendation sentence. Only the last step calls a
model. Idempotent across three consecutive runs of the same attempt.

**Task 18 complete.** Mastery + Growth UI.

- `analyseGrowth` in `packages/shared/src/learning/growth.ts` — deterministic,
  no AI. Absolute standing outranks direction (D-049).
- `GET /api/projects/:id/growth`, trends derived on read from
  `mastery_history`, never stored as a flag.
- **Bug caught and fixed:** the history query was ordered ascending with
  `limit(500)`, capping the window at the OLDEST rows. Past 500 assessments a
  project's trend would have frozen while its score kept moving.
- `averageMastery` covers assessed concepts only; untested show "—", not 50%.
- Quiz and Growth are now reachable from the project dashboard. Both routes
  existed with nothing linking to them.

**Task 19 complete.** Persistent learning context + recommendations in the UI.

- `selectFacts()` in `@asc/shared` — deterministic narrowing of
  `learner_facts` to what applies to this question (D-050). Lexical, not
  embedded; salience decayed on read with a 10-day half-life.
- Matched against the TOP-RANKED chunk, not the whole retrieval set. The
  integration test caught the difference — on a small document retrieval
  returns nearly everything, so every fact looked relevant and the gate was
  vacuous while appearing to work.
- `factsUsed` on the tutor diagnostics and the `tutor_answer` event.
- Recommendation cards link to the action they suggest and can be dismissed.

**Task 20 complete.** Project + Global analytics.

- `packages/shared/src/analytics/` — bucketing, streaks, assessment summary,
  AI usage as pure functions (27 tests).
- `GET /api/projects/:id/analytics` · `GET /api/analytics`, both through the
  caller's JWT so RLS enforces isolation.
- Charts single-series by construction: `--ok` vs `--error` measures at deutan
  ΔE 7.9, under the ΔE 8 target (D-051).

**The important find of this session (D-052): the web build had been emitting a
bundle with no application code in it since task 1**, and "web build OK" was
recorded as evidence the whole time. Vite reads `.env` from `apps/web/`; this
repo keeps one at the root. `supabase.ts` throws at module scope without it, the
minifier proved the throw unconditional, and eliminated the whole app as dead
code — exit 0, plausible size, no warning. Production was never affected
(Vercel has the vars set; the live bundle is 503 kB with the app present).

Now fixed three ways: `envDir: '../../'`, a Vite plugin that fails a production
build on a missing `VITE_*`, and `apps/web/scripts/verify-bundle.mjs` as a
postbuild step that greps the OUTPUT for markers from four app files. The
postbuild check was verified by truncating a real bundle and confirming a
non-zero exit.

**Task 21 complete.** Admin Dashboard.

- `/api/admin/overview` · `/users` · `/activity` · `/ai` · `/evals`, gated on
  `profiles.role` from the database.
- Queries go through the CALLER'S JWT, not the service role — RLS widens for an
  admin via `is_admin()`. A missing preHandler then leaks the caller's own rows
  instead of everyone's (D-053).
- 18 tests, incl. promotion mid-session proving reach is not in the token.
- Caught: the evals route was written against invented `eval_runs` columns. It
  typechecked and would have 500'd on demo day.

**Task 22 complete.** AI evaluation suite — `npm run eval`.

- 17 curated cases across tutor / retrieval / assessment / recommendation /
  security. **First full run: 17/17 in 262s.**
- Graded against a purpose-written 4-page fixture with recorded ground truth,
  so "cited the right page" is checkable (D-054). Rule-based, not model-based.
- Persists to `eval_runs` / `eval_results` with the git sha; admin Evaluation
  tab reads it. Exits non-zero on failure.
- `npm run eval <suite>` runs one suite; `npm run eval -- --list` lists cases.
- Found two bugs in itself: it was destroying its own cost record (twice, two
  different cascades) and one case asserted behaviour the design deliberately
  does not have. Run cost now lands in `eval_runs.summary._cost`.

**Task 23 complete.** Test pass over the two gaps that were real.

- `jobResilience.test.ts` — 8 cases on job failure, retry and recovery
  (PRD §13): failure status survives the rethrow, a failed material recovers
  without re-upload, three runs produce zero duplicate chunks, a shrinking
  document drops stale trailing chunks, a forged ownership payload processes
  nothing, a deleted material is skipped not retried, a partially embedded
  document is never called ready.
- `validation.test.ts` — 20 cases on the HTTP edge (PRD §15). All passed on the
  first run; the validation layer was already sound.
- Found: Supabase Storage returns the OLD object after an in-place overwrite
  while reporting success (D-055). No product impact — every upload takes a
  fresh UUID path — but it invalidated two tests.

**Task 24 complete.** Resilience sweep — the layer ABOVE the provider.

- Browser request timeouts: 30s ordinary, 150s behind a model (the TPM limiter
  WAITS, so a queued Tutor answer legitimately takes most of a minute).
- A 401 returns to sign-in once, instead of "Unauthorized" on every panel.
  **403 deliberately does not** — authenticated but not permitted.
- `ErrorBoundary` keyed on the ROUTER's pathname (`window.location` would stay
  latched all session).
- Network failure says "Could not reach the server", not "Failed to fetch".
- 11 API-client cases + 4 provider-failure integration cases (D-056).

**Task 25 complete.** `npm run rehearse` — the full loop against PRODUCTION.

Fresh account → space → project → PDF upload → **deployed worker** indexes it →
grounded answer → refusal → injection attempt → adaptive quiz → mastery →
growth → analytics → cross-account isolation → account deleted.

**Every check passed.** Grounded answer citing page 1 in 1152ms · refusal on an
off-topic question · injection not obeyed · mastery Δ −0.2862 on a wrong answer
· 3804 tokens / $0.00078 tracked · second account 404 on everything.

This is not redundant with the tests: every integration test builds the API
**in-process**, which proves the code and says nothing about the deployment.
The rehearsal is the only thing that proves the Railway worker is alive and the
Vercel bundle contains the app.

It caught one thing no test had: the model returned `【S1】` (fullwidth). The
extractor handles that on purpose (D-034) so nothing failed — but the learner
reads the raw text, and mixed bracket styles look like a product bug. Markers
are now normalised before persisting (D-057).

**Session 2026-09-17 21:10.** Frontend visual redesign merged. The user had a
separate AI tool ("Antigravity") build a full redesign of `apps/web` from an
earlier snapshot of this repo. Audited file-by-file, then merged onto branch
`antigravity-ui-merge` (not yet on `main`) — the new design layer (CSS system,
Sidebar/Topbar shell, Home route, restyled pages) with every piece of
same-day business logic re-ported on top: D-061's 409 quiz-resume, material
retry/poll/progress, `@asc/shared` types, the D-052 build guard (`envDir` +
`verify-bundle.mjs`), and the D-051 colorblind-safe chart palette. Two fake
always-empty nav pages and several inert decorative controls (fake search,
notification badge, RAG toggle, unconfigured Google OAuth) were dropped
rather than shipped. Full detail and rationale in **D-062**.

**Verified:** `tsc -b` clean, 491/491 tests, `npm run build --workspace=@asc/web`
green incl. `verify-bundle.mjs`, and a full logged-in browser walkthrough
(sign-up → space → project → PDF upload → live poll to ready → grounded Tutor
citation → quiz incl. a live-triggered 409-resume → Growth → Analytics →
non-admin 403 on `/admin`) against local `worker`+`api`+`web`.

**NEXT ACTION:** decide whether to merge `antigravity-ui-merge` into `main`
and redeploy (Vercel builds `main`), or keep reviewing first. Not pushed or
merged yet — working tree on the branch is clean and ready.

Sunday's list, which can still start early once the above is resolved:
- **26. Docs** — architecture doc + diagram, README + setup, AI usage doc
  (build-time vs product-time), evaluation approach, known limitations, future
  improvements. `DECISIONS.md` is at **D-057** and is the source material.
- **27. Demo video** — PRD §20.2 shot list, recorded against production.
- **28. Final deploy verification + submit** — re-run `npm run rehearse` and
  `npm run eval` immediately before submitting.

**README written** (§20.3) — quick start, architecture, AI engineering,
evaluation approach, known limitations, future improvements. Every number in it
was verified rather than asserted: 478 tests, 17 eval cases, 19 tables, 35
policies, 57 decisions, and the documented worker command was actually booted
from the repo root.

Remaining for Sunday: the architecture doc + diagram as a standalone file, the
AI-usage doc (AI used to BUILD vs AI used BY the product), and the demo video.

### Schedule reality check

It is **Thursday afternoon**. The real deadline is **Saturday night**, with
Sunday morning as buffer for deployment checks and documentation only.

**All 25 build tasks are done, two days early.** plus Sunday's docs and
video. Friday's plan was to reach 19 and it landed a day early, so Friday is
spent on 20-25; Friday and Saturday are now free for docs, the video, and any polish — the first genuine slack in
this build.

**Every "protect at any cost" item is built and tested** — 11, 12, 14 and 22.
The cut list below was never needed. What remains is documentation, the demo
video, and final verification.

---

## Blockers

| # | Blocker | Owner | Unblocks |
|---|---------|-------|----------|
| ~~B-1~~ | ~~git Xcode license~~ | — | **RESOLVED** 2026-09-16, git 2.54.0 working |
| ~~B-2~~ | ~~No Supabase project~~ | — | **RESOLVED** 2026-09-16, ref `maeifbzqpehidwuprypv` |
| ~~B-2b~~ | ~~service role key + DATABASE_URL~~ | — | **RESOLVED** 2026-09-16, DB connection verified |
| ~~B-3~~ | ~~AI provider keys~~ | — | **RESOLVED** 2026-09-16, both smoke-tested live |
| ~~B-4~~ | ~~Vercel + Railway not linked~~ | — | **RESOLVED** 2026-09-16, all three services live and verified |

---

## Task checklist

Status: ` ` todo · `~` in progress · `x` done · `-` cut

### Wed night — foundation
- [x] **1. Monorepo scaffold** — npm workspaces: `apps/web`, `apps/api`, `packages/shared`, `packages/ai`. *Done:* typecheck clean, 6 tests green, web build OK, API `/health` 200.
- [x] **2. Supabase project + full schema migration** — *Done:* project `maeifbzqpehidwuprypv`, 5 migrations applied, 19 tables, pgvector 0.8.2 + HNSW cosine index on `material_chunks.embedding`.
- [x] **3. RLS policies + isolation test** — every table keyed to `auth.uid()`; API uses caller's JWT so Postgres enforces isolation; worker uses service role with explicit `project_id`/`user_id` filters from the job payload. *Done:* 35 policies in `0006_rls_policies.sql`; 12 integration cases green against the live DB.
- [x] **4. Auth end-to-end** — Supabase Auth, Fastify JWT middleware, React auth context + gated routes, `profiles.role` for admin. *Done:* 9 auth integration tests + live HTTP smoke; single-round-trip auth (D-015).
- [x] **5. Deploy config + local verification** — Dockerfile, `.dockerignore`, `vercel.json`, `docs/DEPLOYMENT.md`. *Done:* image builds, both entrypoints boot against the real DB, pg-boss schema created, graceful SIGTERM, non-root. **Live and verified in production.**

### Thu — material pipeline, RAG, Tutor
- [x] **6. Spaces + Projects CRUD** — incl. goal field, one-request project dashboard, learning events. *Done:* 19 integration tests + live verification.
- [x] **7. `packages/ai` provider layer** — Groq + Gemini impls, backoff+jitter, TPM-aware token-bucket limiters, primary→fallback failover, `ai_requests` row per call. *Done:* 56 unit tests incl. mocked-429 failover; live smoke verified both providers + 3 ai_requests rows.
- [x] **8. PDF upload + background processing** — Storage upload, `material.process` pg-boss job, queued→processing→ready/failed in UI, retries + idempotency so a retry can't double-insert chunks. *Done:* live end-to-end, reprocess produced zero duplicate chunks.
- [x] **9. Page-aware chunking + embedding** — per-page extract, ~800-token chunks with overlap, never crossing a page boundary (D-005). Gemini batched ~20 @ ~700ms. *Done when:* 40-page PDF indexes with no 429; page attribution spot-checked.
- [x] **10. Retrieval + Tutor with grounded citations** — project-scoped vector search, compact context (TPM), primary model, `Source: <doc> — Page N` linking back to material. *Done:* live — citations resolved to pages 19 and 9, both correct against the source.
- [x] **11. Unsupported-question handling** — deterministic evidence-sufficiency gate before generation. *Done when:* question absent from material yields a refusal, not a fabrication. **Explicit PRD evaluation criterion — protect this.**
- [x] **12. Prompt-injection boundary** — retrieved chunks + user messages wrapped as delimited data with an explicit never-instructions contract. *Done:* 3-layer defence (structural, instructional, output-side). Adversarial PDF fixture in-repo. 5/5 repeat runs clean (D-035).

### Fri — assessment, mastery, growth, recommendations
- [x] **13. Concept extraction** — LLM over a sampled, token-capped subset of chunks (not the whole doc), zod-validated before persisting.
- [x] **14. Deterministic learning core** — pure functions in `packages/shared`, no AI: mastery update (evidence-weighted, difficulty-aware, recency-decayed), adaptive concept+difficulty selection, repeated-mistake detection, recommendation trigger rules. *Done:* 84 pure-function tests, no AI anywhere in the chain. Two design bugs caught by tests (D-039).
- [x] **15. Quiz — MCQ generation + flow** — selection deterministic (task 14), only wording generated, on the fallback model; JSON mode + schema in prompt + zod validation before persist; reusable questions cached in `question_bank` by (concept, difficulty, type). *Done:* live 4-question quiz across 4 concepts, mastery updated per answer, answer never sent to client, learner cannot forge mastery.
- [x] **16. Open-ended assessment + grading** — fallback model, one answer at a time; feedback explains what was understood and what's missing, not just a score; validated before it touches mastery.
- [x] **17. Quiz-completion workflow** — pg-boss chain: evaluate → update mastery → detect weakness → generate recommendation. Idempotent by attempt id. *Done when:* close the browser mid-flight, mastery + recommendation still land (PRD §13).
- [x] **18. Mastery + Growth UI** — per-concept bars, improving/stable/needs-attention from mastery history. *Done:* trends derived on read; 8 route tests + 12 pure-function tests; ascending-window bug fixed (D-049).
- [x] **19. Recommendations + persistent learning context** — deterministic trigger, generated sentence; `learner_facts` retrieved *selectively* into Tutor context. *Done:* live integration test proves a weakness written two days earlier reaches a relevant answer and stays out of an unrelated one (D-050).

### Sat — analytics, admin, observability, eval, tests, ship
- [x] **20. Learning events + Project/Global analytics** — events emitted throughout earlier tasks; analytics read from them. *Done:* 27 pure-function tests + 12 route tests; caught D-052 (the web build was shipping no app code).
- [x] **21. Admin Dashboard** — users, spaces, projects, filterable activity, AI usage + cost, job health, eval results; role-gated server-side. *Done:* 18 tests; non-admin 403 on every route; admin reach proven to come from the DB, not the token (D-053).
- [x] **22. AI evaluation suite** — curated cases: Tutor groundedness + citation correctness, retrieval relevance, unsupported-question handling, structured-output reliability, grading quality. `npm run eval`, results persisted + shown in admin. *Done:* 17/17 across 5 suites (D-054). **Was the protected item; it is now built.**
- [x] **23. Test pass** — fill gaps: auth/isolation/validation, mastery/adaptive/recommendation, job retry + failure. *Done:* 28 new cases (8 job resilience, 20 validation); found D-055.
- [x] **24. Error handling + resilience sweep** — timeouts, provider failure fallback, invalid AI output paths, failed-job recovery, user-facing error states. *Done:* 15 new cases; browser timeouts, 401-vs-403, error boundary (D-056).
- [x] **25. Production deploy + full loop rehearsal** on the live URL with a fresh account. *Done:* `npm run rehearse`, every check green against production; caught the citation-marker inconsistency (D-057).

### Sun AM — buffer only, no new features
- [x] **26. Docs** — *Done:* `docs/ARCHITECTURE.md` (+ diagram), `README.md`, `docs/AI_USAGE.md`, `docs/PROMPTS.md`, `docs/PRD_COVERAGE.md`. Evaluation approach and known limitations are in the README; `DECISIONS.md` is at **D-078**.
- [ ] **27. Demo video** — PRD §20.2 shot list, recorded against production.
- [ ] **28. Final deploy verification + submit.**

---

## Cut order if Friday runs long

1. Rich growth charts → fall back to a simple trend label
2. `question_bank` caching
3. Global analytics beyond a basic aggregate

**Never cut:** 11 (unsupported-question), 12 (injection boundary), 14
(deterministic core), 22 (evaluation). That's where the PRD's stated criteria
concentrate.

**Out of scope until all 23 Must-Haves work:** everything in Should Have
(streaming Tutor, AI tracing, caching...). Exception: provider abstraction and
basic tracing come free with task 7, since two providers require them anyway.

---

## Deliverables (PRD §20) — do not lose track

| # | Deliverable | Status |
|---|-------------|--------|
| 1 | Working deployed application | **LIVE and current.** Verified by `npm run rehearse` against the deployed URLs, not by a green deploy log. |
| 2 | Demo video (§20.2 shot list) | not started (Sunday) |
| 3 | Public GitHub repo w/ README, setup, config examples | **done** — README + `.env.example` + `docs/DEPLOYMENT.md` |
| 4 | Architecture documentation + diagram | `DECISIONS.md` at D-057; doc + diagram not written |
| 5 | AI usage doc — AI used to *build* vs AI used *by* the product | not started |
| 6 | Development prompts, organized by area | **user is tracking this, not Claude** |
| 7 | Evaluation approach | **done** — built (`npm run eval`) and written up in the README |
| 8 | Known limitations | **done** — a section in the README, sourced from D-049, D-051, D-054 |
| 9 | Future improvements (optional) | **done** — "If there were more time" in the README |

---

## Key commands

```bash
npm install                 # from repo root, hoists all workspaces
npm run typecheck           # all workspaces
npm test                    # vitest, whole repo
npm run dev:api             # Fastify on :8080
npm run dev:worker          # pg-boss worker
npm run dev:web             # Vite on :5173
npm run eval                # all 17 evaluation cases (~4 min, spends real quota)
npm run eval tutor          # one suite: tutor|retrieval|assessment|recommendation|security
npm run eval -- --list      # list every case and what it protects
npm run rehearse            # full loop against PRODUCTION with a fresh account
npm run rehearse -- --keep  # same, but leave the account for manual poking

# read the PRD (no poppler on this machine)
python3 -c "import pymupdf; d=pymupdf.open('/Users/mahesh/Project_Requirements.pdf'); print('\n'.join(p.get_text() for p in d))"
```

## Conventions

- Workspace packages are scoped `@asc/*` (`@asc/shared`, `@asc/ai`, `@asc/api`, `@asc/web`).
- Code comments cite decisions by id: `// see D-005`.
- Every AI provider call writes an `ai_requests` row — no exceptions, that's the
  observability story (PRD §14).

---

## Supabase project facts

- **Project ref:** `maeifbzqpehidwuprypv` · org `victory-bazars-db` (`bnxfczoovrtprjofiqlt`)
- **Region:** `ap-south-1` · **Postgres:** 17 · **pgvector:** 0.8.2
- **URL:** `https://maeifbzqpehidwuprypv.supabase.co`
- **Publishable key:** `sb_publishable_33ygh1ibF_tRfswPbH4y9A_D_y8-CC_` (safe in the browser; RLS is the protection)
- **Migrations:** `supabase/migrations/000{1..5}_*.sql`, kept in the repo and applied via the Supabase MCP tools.

### Tables (19)
`profiles` `spaces` `projects` · `materials` `material_chunks` `concepts`
`concept_mastery` `mastery_history` · `conversations` `messages`
`quiz_attempts` `quiz_questions` `question_bank` · `learner_facts`
`recommendations` `learning_events` `ai_requests` `eval_runs` `eval_results`

### Standing rule
Run the security advisor after every DDL change:
`mcp__claude_ai_Supabase__get_advisors(project_id, type='security')`.
It caught D-011 within a minute of the schema landing.


---

## State as of 2026-09-17 14:30 — full snapshot

### Built and verified (tasks 1-25)

| # | Task | Evidence it actually works |
|---|---|---|
| 1 | Monorepo scaffold | typecheck clean, 4 workspaces |
| 2 | Schema, 19 tables, pgvector | 8 migrations applied |
| 3 | RLS, 35 policies | 12 isolation tests vs the real DB |
| 4 | Auth end-to-end | 9 tests + live HTTP; role read from DB not token |
| 5 | Deployment | all 3 services live, full auth chain passes in prod |
| 6 | Spaces + Projects CRUD | 19 tests incl. cross-user + mass-assignment |
| 7 | AI provider layer | 56 tests; live: generate, JSON-validated, embeddings |
| 8 | PDF upload + background job | live: 25 pages, 25 chunks, idempotent reprocess |
| 9 | Embeddings + retrieval | live: 25/25 embedded, 5/5 on-topic, 4/4 off-topic |
| 10 | Tutor with citations | live: citations resolved to pages 19 and 9, both correct |
| 11 | Unsupported questions | refuses on empty project and on off-topic question |
| 12 | Injection boundary | adversarial PDF fixture, 5/5 repeat runs clean |
| 13 | Concept extraction | sampled + token-capped, zod-validated, no-op on re-run |
| 14 | Deterministic learning core | 84 pure-function tests, zero AI in the chain |
| 15 | MCQ quiz flow | live 4-question quiz, answer never sent to client |
| 16 | Open-ended grading | rubric stored with question; grade sanitised before mastery |
| 17 | Quiz-completion workflow | idempotent across three runs of the same attempt |
| 18 | Mastery + Growth UI | 8 route tests; oldest-window bug caught and fixed (D-049) |
| 19 | Persistent learning context | live: 2-day-old weakness reaches a relevant answer only |
| 20 | Project + Global analytics | 39 tests; cross-user isolation on both endpoints |
| 21 | Admin dashboard | 18 tests; promotion mid-session proves reach is not in the token |
| 22 | AI evaluation suite | `npm run eval` → 17/17 across 5 suites, persisted with git sha |
| 23 | Job + validation test pass | 8 job resilience cases, 20 validation cases |
| 24 | Resilience sweep | 15 cases; timeouts, 401-vs-403, error boundary |
| 25 | Production rehearsal | `npm run rehearse` green end to end against the live stack |
| — | Bugs from real use | CORS methods, quiz latency, body-less POST (D-058/059/060) |

**491 tests passing**, plus 17 evaluation cases (`npm run eval`) and the
production rehearsal (`npm run rehearse`). `npx vitest run` from the repo root.
Live-AI tests need the real keys: `node --env-file=.env ./node_modules/.bin/vitest run`.

### Production (all verified live, not localhost)
- Frontend https://ai-study-companion-ruby.vercel.app
- API https://ai-study-companion-production-a07f.up.railway.app
- Worker: Railway service `hospitable-light` (no domain, by design)
- Railway project `determined-empathy` / `production`
- Supabase `maeifbzqpehidwuprypv` · `ap-south-1` · PG17 · pgvector 0.8.2

### Repo
`sunkaramahesh09/ai-study-companion`, branch `main`, all pushed.
Working tree clean except `.env` and `.env.railway` (both gitignored).

---

## Landmines — things that have already cost time

1. **`PGBOSS_SCHEMA=pgboss_dev` must be in `.env`** (D-031). Dev shares
   `DATABASE_URL` with production, so without it a local worker competes with
   the deployed Railway worker for the same jobs, and whichever wins decides
   which *version of the code* processes a document. This produced results that
   alternated between 25/25 and 0/25 embedded with no code change. Railway keeps
   the default `pgboss`.

2. **Kill stale local workers before testing:**
   `pkill -9 -f "worker.ts"; pkill -9 -f "server.ts"` then `sleep 2`.
   A leftover worker from an earlier task will silently process jobs with old
   code.

3. **Start the worker BEFORE the API** when testing the pipeline, and give it
   ~3s to register its handler.

4. **Never claim a constant is "measured" without measuring it.** The relevance
   threshold was set to 0.62 with a comment saying it had been measured; it had
   not. The real numbers put every off-topic query inside that gate. See D-029.

5. **Vite bakes `VITE_*` at build time** — changing one in Vercel needs a
   redeploy, not just a save. **This landmine was real and it went off (D-052):**
   a build without those vars emits a bundle containing NO APP CODE, exits 0,
   and prints a normal-looking size. Now guarded three ways, incl.
   `apps/web/scripts/verify-bundle.mjs` as a postbuild step. Never take "the
   build passed" as evidence the app was built.

6. The clipboard-image paste path did not work in this session; ask the user to
   save screenshots to a file if an image is needed.

7. **Live-AI tests are run against real models and occasionally flake on
   content assertions.** `tutorBehaviour.test.ts` has one case matching an
   answer against `/light|temperature/`; it failed once in a full run and
   passed on re-run with no code change. Re-run a single failing live test
   before believing it. Deterministic assertions (what the server *chose* to
   send) are preferred over assertions on model wording — see
   `learnerContext.test.ts`, which asserts on `factsUsed`, not on phrasing.

11. **`beforeEach(() => mock.mockReset())` calls the mock again.** `mockReset()`
    returns the mock, and vitest treats a value returned from a hook as a
    teardown function — so the concise arrow form invokes the stub once more
    after every test. Invisible while the stub resolves; the one test that makes
    it *throw* then fails with an unhandled error while its own assertions pass.
    Use a block body. Cost ~20 minutes chasing a passing test's failure (D-075).

8. **`npx vitest run` skips every live test silently** — they are guarded on
   env vars being present. Use `node --env-file=.env ./node_modules/.bin/vitest run`
   or a green run means much less than it looks like.

10. **Supabase Storage returns the OLD object after an in-place overwrite**,
    while reporting the upload as successful (D-055). The app is unaffected —
    every upload takes a fresh UUID path — but never write a test that
    overwrites a path and reads it back. The bucket also rejects any MIME type
    other than `application/pdf` at the storage layer.

9. **A PostgREST multi-row insert unions the column keys across rows** and
   sends an explicit NULL for the ones a given row omits. A NOT NULL column
   with a default therefore fails — and fails the whole batch. Cost ~15 minutes
   in the analytics test seeding, where `.insert([...])` returned an error
   nobody was checking. **Always check `.error` on seeding inserts**; a silent
   seed failure surfaces later as a wrong assertion about the code under test.

---

## Local dev commands

```bash
# always clear stale processes first
pkill -9 -f "worker.ts"; pkill -9 -f "server.ts"; sleep 2

cd apps/api && node --env-file=../../.env src/worker.ts &   # start worker first
sleep 3
cd apps/api && node --env-file=../../.env src/server.ts &   # then the API
npm run dev:web                                             # :5173

npx vitest run                    # 123 tests
npx tsc -b packages/shared packages/ai apps/api apps/web
npm run build --workspace=@asc/web
```

Test accounts: create via the service role
(`admin.auth.admin.createUser({email, password, email_confirm: true})`),
then sign in with the anon key to get a real JWT. Always delete the user at the
end — `auth.users` cascades to everything.

## Admin access

There is no seeded admin and no admin login in the repo — `role` lives in
`public.profiles` and is read from the database on every request (D-053), so an
admin is made, not configured. To create one:

```bash
node --env-file=.env scripts/create-admin.mjs admin@yourdomain.com "Admin Name"
```

It prompts for the password with echo off (nothing reaches shell history, the
repo or a log), creates the auth user, and sets `profiles.role = 'admin'`.
Re-running it on an existing email promotes that account and leaves the
password alone. Then sign in normally — the Admin link appears in the sidebar
because the role comes from the database, not from the token.

To check who is an admin:

```bash
node --env-file=.env -e "
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
console.table((await db.from('profiles').select('email, role').eq('role','admin')).data);
"
```
