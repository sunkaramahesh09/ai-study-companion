# Build Runbook

**Purpose:** survive a cleared context. This is the single source of truth for
build state. Read it at the start of every session; update it at the end of
every task. Keep it terse and factual — status, not narrative.

**Last updated:** 2026-09-17 09:15 · **Day:** Wed (night) · **Deadline:** Sat 2026-09-19 night

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

**Session ended 2026-09-17 ~00:50.** Tasks 1-9 are complete, pushed, and live.

**Tasks 10, 11 and 12 complete.** Grounded Tutor, unsupported-question
handling, and the prompt-injection boundary — the three highest-risk items on
the whole plan.

**NEXT ACTION: task 13 — concept extraction** (LLM over a sampled, token-capped
subset of chunks, zod-validated before persisting), then task 14, the
deterministic learning core.

Much of task 11 already exists as a by-product of task 10: `retrieve()`
distinguishes `no_materials` / `not_indexed` / `no_relevant_evidence`, the
refusal is a deterministic template (no tokens spent), `grounded` is persisted
per message, and `tutor_unsupported` is its own event type. Task 11 is now
mostly about building the curated case set and proving the behaviour holds —
which feeds directly into task 22.

Task 12's boundary is already implemented in `tutorPrompt.ts`
(`renderSources` neutralises delimiters, system prompt states data-not-
instructions) and unit-tested. What is missing is the adversarial fixture PDF
and the end-to-end proof.

### What task 10 needs (everything is in place for it)
- `retrieve(db, projectId, query)` in `apps/api/src/lib/retrieval.ts` returns
  ranked chunks with `filename` + `pageNumber` already attached for citations.
- `generationProvider()` in `apps/api/src/lib/ai.ts` — use the **primary** tier
  for Tutor answers, default reasoning effort.
- Tables ready: `conversations`, `messages` (with `citations` jsonb and a
  `grounded` boolean that records a refusal as a first-class outcome).
- Keep the prompt inside ~2200 tokens of context; `retrieve()` already caps it.
- **Never cache a Tutor answer** (CLAUDE.md) — it is a correctness bug.

### Then, in order
- **Task 11** — unsupported-question handling. The retrieval gate exists
  (`reason: no_relevant_evidence`); task 11 adds the second, independent defence
  at the prompt level. See D-029 for why one is not enough.
- **Task 12** — prompt-injection boundary. Build the adversarial fixture PDF.
- Tasks 13-19 (Friday), 20-25 (Saturday).

---

## Schedule reality check — read this before planning the day

It is now **Thursday ~00:50**. The real deadline is **Saturday night**.
Tasks 1-9 done; **16 tasks remain** (10-25) plus Sunday's documentation.

Thursday must land 10, 11, 12 and ideally 13. If Thursday ends without the
Tutor answering with citations and refusing unsupported questions, the plan
needs re-cutting, not more hours. The cut list below is the first thing to
revisit, not the last.

**Protect at any cost:** 11 (unsupported-question), 12 (injection boundary),
14 (deterministic core), 22 (evaluation). That is where the PRD's stated
criteria concentrate.

---

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
- [ ] **13. Concept extraction** — LLM over a sampled, token-capped subset of chunks (not the whole doc), zod-validated before persisting.
- [ ] **14. Deterministic learning core** — pure functions in `packages/shared`, no AI: mastery update (evidence-weighted, difficulty-aware, recency-decayed), adaptive concept+difficulty selection, repeated-mistake detection, recommendation trigger rules. *Done when:* unit tests cover each. **The unit tests ARE the deliverable — stated evaluation criterion. Protect this.**
- [ ] **15. Quiz — MCQ generation + flow** — selection deterministic (task 14), only wording generated, on the fallback model; JSON mode + schema in prompt + zod validation before persist; reusable questions cached in `question_bank` by (concept, difficulty, type). *Done when:* next question tracks the selection function, not a coin flip.
- [ ] **16. Open-ended assessment + grading** — fallback model, one answer at a time; feedback explains what was understood and what's missing, not just a score; validated before it touches mastery.
- [ ] **17. Quiz-completion workflow** — pg-boss chain: evaluate → update mastery → detect weakness → generate recommendation. Idempotent by attempt id. *Done when:* close the browser mid-flight, mastery + recommendation still land (PRD §13).
- [ ] **18. Mastery + Growth UI** — per-concept bars, improving/stable/needs-attention from mastery history.
- [ ] **19. Recommendations + persistent learning context** — deterministic trigger, generated sentence; `learner_facts` retrieved *selectively* into Tutor context. *Done when:* Tutor references a known weakness unprompted in that message.

### Sat — analytics, admin, observability, eval, tests, ship
- [ ] **20. Learning events + Project/Global analytics** — events emitted throughout earlier tasks; analytics read from them.
- [ ] **21. Admin Dashboard** — users, spaces, projects, filterable activity, AI usage + cost, job health, eval results; role-gated server-side. *Done when:* non-admin gets 403.
- [ ] **22. AI evaluation suite** — curated cases: Tutor groundedness + citation correctness, retrieval relevance, unsupported-question handling, structured-output reliability, grading quality. `npm run eval`, results persisted + shown in admin. **Protect this.**
- [ ] **23. Test pass** — fill gaps: auth/isolation/validation, mastery/adaptive/recommendation, job retry + failure.
- [ ] **24. Error handling + resilience sweep** — timeouts, provider failure fallback, invalid AI output paths, failed-job recovery, user-facing error states.
- [ ] **25. Production deploy + full loop rehearsal** on the live URL with a fresh account.

### Sun AM — buffer only, no new features
- [ ] **26. Docs** — architecture doc + diagram, README + setup, AI usage doc (build-time vs product-time), evaluation approach, known limitations, future improvements. Assembled from `DECISIONS.md`.
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
| 1 | Working deployed application | **LIVE** — frontend, API, worker all verified |
| 2 | Demo video (§20.2 shot list) | not started |
| 3 | Public GitHub repo w/ README, setup, config examples | repo exists, empty |
| 4 | Architecture documentation + diagram | `DECISIONS.md` accumulating |
| 5 | AI usage doc — AI used to *build* vs AI used *by* the product | not started |
| 6 | Development prompts, organized by area | **user is tracking this, not Claude** |
| 7 | Evaluation approach | not started (task 22) |
| 8 | Known limitations | `DECISIONS.md` accumulating |
| 9 | Future improvements (optional) | `DECISIONS.md` accumulating |

---

## Key commands

```bash
npm install                 # from repo root, hoists all workspaces
npm run typecheck           # all workspaces
npm test                    # vitest, whole repo
npm run dev:api             # Fastify on :8080
npm run dev:worker          # pg-boss worker
npm run dev:web             # Vite on :5173
npm run eval                # AI evaluation suite (task 22)

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

## State as of 2026-09-17 00:50 — full snapshot

### Built and verified (tasks 1-9)

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

**123 tests passing.** `npx vitest run` from the repo root.

### Production (all verified live, not localhost)
- Frontend https://ai-study-companion-ruby.vercel.app
- API https://ai-study-companion-production-a07f.up.railway.app
- Worker: Railway service `hospitable-light` (no domain, by design)
- Railway project `determined-empathy` / `production`
- Supabase `maeifbzqpehidwuprypv` · `ap-south-1` · PG17 · pgvector 0.8.2

### Repo
`sunkaramahesh09/ai-study-companion`, branch `main`, 15 commits, all pushed.
Working tree clean except `.env` and `.env.railway` (both gitignored).

---

## Landmines — things that already cost time tonight

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
   redeploy, not just a save.

6. The clipboard-image paste path did not work in this session; ask the user to
   save screenshots to a file if an image is needed.

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

---

## Deliverables status (PRD §20)

| # | Deliverable | Status |
|---|---|---|
| 1 | Working deployed application | **LIVE**, core loop still incomplete (Tutor onwards) |
| 2 | Demo video | not started (Sunday) |
| 3 | Public repo + README | repo live; README still to write |
| 4 | Architecture doc + diagram | `DECISIONS.md` at D-031; diagram not drawn |
| 5 | AI usage doc | not started |
| 6 | Development prompts | **user is tracking this, not Claude** |
| 7 | Evaluation approach | task 22 |
| 8 | Known limitations | accumulating: D-022, D-027, D-028, D-029, D-031 |
| 9 | Future improvements | accumulating in the same entries |
