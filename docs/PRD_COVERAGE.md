# PRD Coverage

Every **Must Have** from PRD §18, mapped to where it is implemented and what
proves it works. Written so a reviewer can check a claim in one click instead of
taking it on faith.

Legend: **Done** · **Partial** (working, with a stated gap) · **Not built**

---

## Must Have

| # | Requirement | Where | Evidence |
|---|---|---|---|
| 1 | **Authentication** | Supabase Auth · `apps/api/src/plugins/auth.ts`, `lib/jwt.ts` · `apps/web/src/auth/` | `auth.test.ts` — no token 401, forged token 401, valid token resolves the right user. Verified against production |
| 2 | **Spaces and Projects** | `routes/spaces.ts`, `routes/projects.ts` · `Spaces.tsx`, `SpaceDetail.tsx`, `ProjectDashboard.tsx` | `crud.test.ts` — full CRUD, cross-user access through HTTP, and a mass-assignment test posting another user's `user_id` |
| 3 | **PDF materials** | `routes/materials.ts` · `lib/pdf.ts` · private `materials` bucket | `pdf.test.ts` — real-PDF extraction asserting each chunk's text appears on the page it cites. Non-PDF rejected by **magic bytes**, not Content-Type |
| 4 | **Background document processing** | pg-boss · `jobs/materialProcess.ts`, `jobs/materialConcepts.ts` · `worker.ts` | `jobResilience.test.ts`. Verified live: 247 KB upload → queued → ready, 25 pages / 25 chunks, **reprocess produced no duplicate chunks** |
| 5 | **AI Tutor** | `lib/tutor.ts`, `lib/tutorPrompt.ts` · `routes/tutor.ts` · `Tutor.tsx` | `tutorBehaviour.test.ts` (live models), `tutorPrompt.test.ts`, `learnerContext.test.ts` |
| 6 | **Grounded answers with citations** | `lib/retrieval.ts` → `renderSources` → `extractCitations` | Eval `tutor.cites-the-page-the-fact-is-on` — not that citations exist, but that the cited page is the page the fact is printed on |
| 7 | **Unsupported-question handling** | `buildInsufficientEvidenceReply` — a **deterministic template**, no model call | Evals `tutor.refuses-what-the-material-does-not-cover`, `tutor.refusal-is-free-and-explains-itself` (asserts `model === null`, i.e. zero tokens) |
| 8 | **Adaptive Quiz** | `packages/shared/src/learning/selection.ts` · `lib/quiz.ts` · `routes/quiz.ts` | `selection.test.ts`, `quizFlow.test.ts`, eval `assessment.adaptive-selection-is-deterministic-and-sane`. Scores four signals; the PRD's "wrong → easy" is explicitly rejected and the rejection is tested |
| 9 | **Open-ended assessment** | `lib/grading.ts` — score, understood, missing, suggestion | `grading.test.ts`, eval `assessment.grading-distinguishes-a-good-answer-from-a-bad-one` and `…-ignores-an-answer-that-tries-to-grade-itself` |
| 10 | **Concept mastery** | `learning/mastery.ts` — surprise-driven update, confidence, staleness, bands | `mastery.test.ts`, `journey.test.ts` |
| 11 | **Growth Analysis** | `learning/growth.ts` · `routes/growth.ts` · `Growth.tsx` | `growth.test.ts` (unit), `growth.test.ts` (API). Trend derived from `mastery_history` on read, not stored |
| 12 | **Recommendations** | `learning/recommend.ts` decides · `lib/recommendations.ts` words it · `jobs/quizCompleted.ts` triggers | `recommend.test.ts`, `recommendations.test.ts`, 3 recommendation evals |
| 13 | **Project and global analytics** | `routes/analytics.ts` · `packages/shared/src/analytics/` · `Analytics.tsx`, `GlobalAnalytics.tsx` | `analytics.test.ts`, `activity.test.ts`. Aggregation is pure functions, so the numbers are unit-tested without a database |
| 14 | **Activity tracking** | `learning_events` + `lib/events.ts`, with idempotency keys | Asserted throughout `crud.test.ts`, `quizFlow.test.ts`, `analytics.test.ts` |
| 15 | **Admin Dashboard** | `routes/admin.ts` (users, activity, AI, evals, health) · `Admin.tsx` · `scripts/create-admin.mjs` | `admin.test.ts`, `adminIsolation.test.ts` — the latter **fails 6 of 10 against the pre-fix code** (D-073), which is what makes it evidence |
| 16 | **Persistent relevant learning context** | `learner_facts` table · `learning/facts.ts` `selectFacts()` — relevance judged against the question *and* the retrieved evidence | `facts.test.ts`, `learnerContext.test.ts` (asserts on `factsUsed`, not on model phrasing) |
| 17 | **Project-level data isolation** | RLS on all 20 tables (36 policies) + explicit `user_id` filters at 31 call sites + ownership in job payloads | `isolation.test.ts`, `adminIsolation.test.ts`, eval `security.project-isolation-holds-under-retrieval` |
| 18 | **Structured AI interaction** | `packages/ai/src/json.ts` `generateJson()` — JSON mode + schema in prompt + **zod validation before the value is returned**, one repair, then hard failure | `json.test.ts`, eval `assessment.structured-output-survives-validation`. See the §8 note below |
| 19 | **Basic AI observability and evaluation** | `ai_requests` (one row per call, written inside the provider) · `apps/api/src/eval/` — 18 cases, 5 suites, `eval_runs`/`eval_results` | `npm run eval`; admin AI and Evaluation tabs |
| 20 | **Error handling** | Backoff + jitter, primary→fallback failover, `503` with the question preserved, deterministic fallbacks for recommendation and progress text | `providerFailure.test.ts`, `retry.test.ts`, `limiter.test.ts`, `tutorProgress.test.ts` |
| 21 | **Testing** | 609 tests across 46 files, plus 18 evaluation cases and a production rehearsal | `npx vitest run`; live tests need real keys — see the README warning |
| 22 | **Deployment** | Vercel (web) · Railway (api + worker) · Supabase | Live URLs in the README; `npm run rehearse` drives the whole loop against production |
| 23 | **Public repository** | `github.com/sunkaramahesh09/ai-study-companion` | Public from the first commit; `.env` gitignored, `.env.example` tracked, no secrets in history |
| 24 | **Architecture documentation** | [`ARCHITECTURE.md`](ARCHITECTURE.md) + [`DECISIONS.md`](DECISIONS.md) (86 entries) | — |

**24 / 24 Must Haves implemented.**

---

## Should Have (§18)

| Requirement | Status | Note |
|---|---|---|
| Streaming Tutor | **Not built** | Answers arrive whole. The groundedness check needs the completed text before citations can be shown |
| Rich document understanding | **Partial** | Per-page text extraction with page provenance. **No OCR, no table or diagram understanding** |
| Improved analytics | **Done** | Day buckets, streaks, windows (7/30/90), per-project traceability, charts |
| Persistent Tutor continuity | **Done** | Conversations restored on reload (D-070); durable `learner_facts` across sessions |
| Background learning insights | **Done** | `jobs/quizCompleted.ts` — weakness detection → learner facts → recommendation |
| Caching | **Done** | `question_bank`, keyed on (concept, difficulty, type). Tutor answers deliberately never cached |
| AI tracing | **Done** | `ai_requests` with feature, model, tier, status, latency, tokens, cost, attempt count |
| Provider abstraction | **Done** | `packages/ai` — two providers, two tiers, swappable without touching the app |
| Automated regression evaluation | **Done** | 18 cases, 5 suites, persisted to `eval_runs`/`eval_results`, non-zero exit on failure |
| Improved workflow retry handling | **Done** | pg-boss retries, `singletonKey`, idempotent upserts, idempotency keys on events |

**8 done, 1 partial, 1 not built.**

---

## Nice to Have (§19)

The PRD invites creative additions on one condition — they *"should not
compromise the core learning experience"*. Nothing here was started before every
Must Have was finished and tested.

| Feature | Status | Note |
|---|---|---|
| **Flashcards** | **Done** | `learning/flashcards.ts` · `lib/flashcards.ts` · `routes/flashcards.ts` · `Flashcards.tsx`. Cards are written from the project's own material and validated before persisting |
| **Spaced repetition** | **Done** | SM-2 derived, pure, `now` injected. Four ratings, a ten-minute relearning step, ease clamped in the algorithm *and* in Postgres, intervals capped at 180 days |
| Voice learning · learning plans · concept maps · simulations · schedules · multi-modal · notifications · collaboration | **Not built** | Out of scope for the time available |

**How the condition was honoured:** which concepts a deck covers is
`scoreConcept` — the *same* selector the adaptive quiz uses, not a second
ranking that could disagree with it — and a flashcard rating deliberately does
**not** move mastery (D-081), so self-report cannot contaminate the measure
every adaptive decision depends on. The deck reads the learning core and never
writes to it. See D-080.

Tests: 17 scheduler unit tests, 17 route tests, 4 live-generation tests.
**Not yet clicked through in a browser** — stated in the README's known
limitations rather than left for a reviewer to discover.

---

## Section-by-section

| § | Requirement | Status |
|---|---|---|
| 3–4 | Spaces / Projects hierarchy, per-Project context | **Done** |
| 5 | Upload → queued → processing → ready/failed, traceable to source | **Done** — OCR not implemented |
| 6 | Tutor understands goal, materials, concepts, conversation, assessment history, without shipping the whole transcript | **Done** — 4 turns + selected durable facts |
| 7 | Grounded answers, citations, insufficient-evidence path | **Done** — the project's central commitment |
| 8 | Controlled AI/application interaction, validated structured output | **Partial** — see below |
| 9 | Adaptive quiz, MCQ + open-ended, feedback that explains | **Done** |
| 10 | Mastery, growth, recommendations | **Done** |
| 11 | Persistent but *relevant* learner context | **Done** |
| 12 | Learning events; Project analytics incl. AI activity; Global analytics | **Done** (D-077) |
| 13 | Event-driven workflows, job states, retries, no browser required | **Done** |
| 14 | AI observability and evaluation across Tutor / retrieval / assessment / recommendations | **Done** |
| 15 | Failure handling, security, isolation, prompt injection, performance | **Done** — no streaming |
| 16 | User Home ("where was I, how am I doing, what next"); Admin Dashboard | **Done** — also answered *by the Tutor* (D-075) |
| 17 | Architecture, separation of responsibilities, justified technology | **Done** |
| 18 | Testing, deployment, secrets out of source | **Done** |

### The one honest Partial: §8

§8 describes a pattern where the AI determines a required action and issues a
structured tool request that the backend validates and executes.

What is built is **application-orchestrated structured generation**: the
application decides which capability to invoke, the model returns structured
data for it, and that data is validated against a zod schema *before* it is
persisted or allowed to change state. The model never holds a handle to the
database or to a privileged operation.

This satisfies §8's stated requirements — *"the AI should not have unrestricted
access to databases, internal services, or privileged application operations"*
and *"AI-generated structured data should be validated before it is persisted or
used to change application state"* — but it is **not an agentic tool-calling
loop**, and it is described as Partial rather than claimed as Done. With more
time, retrieval and question generation are the two capabilities worth exposing
as real tools behind the same validation boundary.

---

## Submission deliverables (§20)

| # | Deliverable | Status |
|---|---|---|
| 1 | Working deployed application | **Done** — [live](https://ai-study-companion-ruby.vercel.app) |
| 2 | **Demo video** | **Outstanding — must be recorded before submitting** |
| 3 | Public repository with README, setup, config examples, testing and deployment info | **Done** |
| 4 | Architecture documentation + diagram | **Done** — [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| 5 | AI usage: build-time vs product | **Done** — [`AI_USAGE.md`](AI_USAGE.md) |
| 6 | Development prompts, organized by area | **Done** — [`PROMPTS.md`](PROMPTS.md), recovered from the real session transcripts |
| 7 | Evaluation approach | **Done** — README "Evaluation" + `apps/api/src/eval/` |
| 8 | Known limitations | **Done** — README "Known limitations" |
| 9 | Future improvements | **Done** — README "If there were more time" |
