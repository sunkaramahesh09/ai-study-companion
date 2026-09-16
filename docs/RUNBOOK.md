# Build Runbook

**Purpose:** survive a cleared context. This is the single source of truth for
build state. Read it at the start of every session; update it at the end of
every task. Keep it terse and factual — status, not narrative.

**Last updated:** 2026-09-16 20:35 · **Day:** Wed (night) · **Deadline:** Sat 2026-09-19 night

---

## Current state

**Task 1 complete.** Monorepo scaffolded and verified: 4 workspaces, 219 deps
installed (0 vulnerabilities), full typecheck clean, `vitest` green (6/6), web
production build succeeds, API boots and serves `/health`.

Nothing is committed yet — git is still license-blocked (B-1).
No Supabase project yet (B-2). No provider API keys yet (B-3).

**Next action:** task 2 — create the Supabase project and apply the full schema
migration in one pass (all tables + pgvector). Blocked on B-2.

---

## Blockers

| # | Blocker | Owner | Unblocks |
|---|---------|-------|----------|
| B-1 | `git` is Apple's Xcode stub, license not accepted. All git + brew commands fail. Fix: user runs `sudo xcodebuild -license accept` (needs their password; cannot be done non-interactively). | **User** | Task 1 commit, task 5 deploy, everything downstream |
| B-2 | No Supabase project created yet. Needs project + `DATABASE_URL` + keys in `.env`. | User or Claude via Supabase MCP | Tasks 2, 3, 4 |
| B-3 | No `GROQ_API_KEY` / `GEMINI_API_KEY` in `.env` yet. | **User** | Tasks 7, 10, 13, 15, 16 |

---

## Task checklist

Status: ` ` todo · `~` in progress · `x` done · `-` cut

### Wed night — foundation
- [x] **1. Monorepo scaffold** — npm workspaces: `apps/web`, `apps/api`, `packages/shared`, `packages/ai`. *Done:* typecheck clean, 6 tests green, web build OK, API `/health` 200.
- [ ] **2. Supabase project + full schema migration** — all tables in one pass, pgvector enabled. *Done when:* migration applies, table list matches.
- [ ] **3. RLS policies + isolation test** — every table keyed to `auth.uid()`; API uses caller's JWT so Postgres enforces isolation; worker uses service role with explicit `project_id`/`user_id` filters from the job payload. *Done when:* integration test proves user B gets 0 rows / 404 on user A's project.
- [ ] **4. Auth end-to-end** — Supabase Auth, Fastify JWT middleware, React auth context + protected routes, `profiles.role` for admin. *Done when:* sign up → sign in → authed endpoint works; 401 without token.
- [ ] **5. Deploy the skeleton (empty)** — Vercel + Railway (api + worker), pg-boss booted. *Done when:* public URL serves a logged-in empty dashboard. Deliberately early: de-risks the single-submission constraint.

### Thu — material pipeline, RAG, Tutor
- [ ] **6. Spaces + Projects CRUD** — incl. goal field, project dashboard shell.
- [ ] **7. `packages/ai` provider layer** — Groq + Gemini impls, backoff+jitter, TPM-aware token-bucket limiters, primary→fallback failover, `ai_requests` row per call. *Done when:* mocked-429 unit tests prove backoff then failover; one live smoke call each.
- [ ] **8. PDF upload + background processing** — Storage upload, `material.process` pg-boss job, queued→processing→ready/failed in UI, retries + idempotency so a retry can't double-insert chunks. *Done when:* kill worker mid-job, confirm clean resume.
- [ ] **9. Page-aware chunking + embedding** — per-page extract, ~800-token chunks with overlap, never crossing a page boundary (D-005). Gemini batched ~20 @ ~700ms. *Done when:* 40-page PDF indexes with no 429; page attribution spot-checked.
- [ ] **10. Retrieval + Tutor with grounded citations** — project-scoped vector search, compact context (TPM), primary model, `Source: <doc> — Page N` linking back to material. *Done when:* cited page actually contains the claim.
- [ ] **11. Unsupported-question handling** — deterministic evidence-sufficiency gate before generation. *Done when:* question absent from material yields a refusal, not a fabrication. **Explicit PRD evaluation criterion — protect this.**
- [ ] **12. Prompt-injection boundary** — retrieved chunks + user messages wrapped as delimited data with an explicit never-instructions contract. *Done when:* adversarial fixture PDF containing "ignore previous instructions" fails to hijack the Tutor. **Protect this.**

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
| 1 | Working deployed application | not started |
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
