# Decision Log

Running record of engineering decisions: what was chosen, why, what was
simplified, and what would be improved with more time. Maintained as the build
progresses — this feeds the Architecture Documentation and Known Limitations
deliverables (PRD §20.4, §20.8).

Each entry is dated and stable-numbered so code comments can cite it (`D-004`).

---

## D-001 — Monorepo with npm workspaces
**Date:** 2026-09-16 · **Area:** Architecture

**Chosen:** A single repository with npm workspaces: `apps/web`, `apps/api`,
`packages/shared`, `packages/ai`.

**Why:** Frontend, backend and worker share request/response types and the
validation schemas that guard AI output. One repo means one place where a schema
changes, and the type error surfaces on both sides immediately. For a prototype
evaluated partly on structure, a monorepo also makes the separation of
responsibilities (PRD §17) legible at a glance.

**Why npm, not pnpm:** pnpm was the first choice. Both installation paths on this
machine (`corepack enable`, `brew install`) require sudo, which the build
environment cannot provide non-interactively. npm 11 ships with Node and supports
workspaces natively, and both Vercel and Railway detect it without configuration.
The cost is a heavier `node_modules`; nothing about the architecture depends on
the package manager.

**Simplified:** No Turborepo/Nx task graph. Workspace scripts are simple enough
that the caching layer would cost more setup time than it saves over three days.

**With more time:** Turborepo for cached CI builds once the test suite is large
enough for the cache to pay for itself.

---

## D-002 — Worker shares the API image, not a separate package
**Date:** 2026-09-16 · **Area:** Architecture / Deployment

**Chosen:** The pg-boss worker lives at `apps/api/src/worker.ts` — a second
entrypoint in the same workspace, deployed as a second Railway service from the
same image with a different start command.

**Why:** The worker needs the same database clients, AI providers, validation
schemas and domain logic as the API. A separate workspace would duplicate the
dependency graph and create two places to keep in sync. Two Railway services from
one image keeps API and worker independently scalable and independently
restartable while halving the deployment surface — which matters under a
single-submission deadline.

**Trade-off:** API and worker scale together in terms of image size and deploy
cadence. At real volume the worker would be split out so a heavy indexing job
can't force an API redeploy.

---

## D-003 — TypeScript pinned to 5.9.3, not 7.x
**Date:** 2026-09-16 · **Area:** Tooling

**Chosen:** `typescript@5.9.3`, pinned exactly rather than caret-ranged.

**Why:** TypeScript 7.0.2 is the current `latest` tag — the native (Go) compiler
rewrite. It is a genuine release, but type-aware linting, some Vite plugins and
parts of the editor tooling ecosystem are still catching up. A submission with no
resubmission window is the wrong place to absorb toolchain risk for a compile-speed
benefit that does not affect the evaluated product. Pinned exactly (not `^`) so a
transitive bump can't move the compiler mid-build.

**With more time:** Migrate after the deadline; the codebase is written in
standard TS and should port without changes.

---

## D-004 — 768-dimension embeddings
**Date:** 2026-09-16 · **Area:** Retrieval

**Chosen:** `gemini-embedding-001` truncated to 768 dimensions via its
Matryoshka (MRL) support, L2-normalized, stored as `vector(768)` with cosine
distance.

**Why:** The model's native output is 3072 dimensions, but pgvector's HNSW and
IVFFlat indexes both cap at 2000 dimensions. Storing 3072-dim vectors would mean
every retrieval falls back to an unindexed sequential scan over the whole chunk
table. 768 keeps retrieval on an index, cuts storage roughly 4x, and MRL is
designed so the leading dimensions carry the most signal — the quality cost is
small and the latency benefit is structural.

**Normalization matters:** MRL-truncated vectors must be re-normalized after
truncation or cosine distance is computed against vectors of inconsistent
magnitude.

**With more time:** Measure retrieval quality at 768 vs 1536 vs 3072 against the
curated eval set, rather than reasoning about it from the model card.

---

## D-005 — Chunks never span a page boundary
**Date:** 2026-09-16 · **Area:** Retrieval / Citations

**Chosen:** PDF text is extracted per page; chunking runs within a single page
and never merges text across pages, even when that leaves a short trailing chunk.

**Why:** The PRD requires citations of the form `Source: Machine Learning Notes —
Page 14` and requires the user to be able to return to the original material
(§7). If a chunk spans pages 13–14, its page number is a guess, and a citation
that is approximately right is a correctness bug in the feature the PRD calls a
core evaluation requirement. Constraining chunks to one page makes the cited page
provably the page the text came from.

**Trade-off:** A concept explained across a page break gets split into two chunks.
Retrieving top-k with k>1 usually recovers both, and the precision of the citation
is worth more than the occasional split.

---

## D-006 — Run TypeScript directly via Node's native type stripping
**Date:** 2026-09-16 · **Area:** Tooling

**Chosen:** No `tsx`, `ts-node` or bundler in the backend dev loop. Node 26 strips
types natively, so `node --watch src/server.ts` runs the server directly. Source
files import each other with real `.ts` specifiers; `allowImportingTsExtensions`
plus `rewriteRelativeImportExtensions` let `tsc` rewrite them to `.js` on emit.

**Why:** One less dependency and one less transform in the dev path, and the file
Node executes in development is the file on disk — stack traces point at real
lines without a source map. Production still runs compiled `dist/*.js` via
`tsc -b`, so type errors remain a build gate rather than a runtime surprise.

**Trade-off:** `rewriteRelativeImportExtensions` only rewrites *relative*
imports. Path aliases would silently break on emit, so the backend deliberately
uses relative imports and workspace package names only — no `@/` aliases.

---

## D-007 — Environment parsed and validated at boot, not at point of use
**Date:** 2026-09-16 · **Area:** Reliability

**Chosen:** A single zod schema in `apps/api/src/env.ts` validates every
environment variable at process start. `parseEnv(source)` is pure; `loadEnv()`
memoizes it over `process.env`.

**Why:** A prototype that boots with a missing `GROQ_API_KEY` and only dies
forty minutes later inside a background indexing job is far harder to debug than
one that refuses to start. Validating at boot also gives exactly one place that
reads secrets, which supports the PRD's requirement that configuration live
outside source (§18).

**Note — split found by test:** the first implementation memoized inside the
function that also accepted a `source` argument, so a second call with different
input silently returned the first parse. The unit test caught it immediately.
Keeping the pure parser and the cached accessor as separate functions is what
makes the boot-time config testable at all.

---

## D-008 — `text` + `CHECK` instead of Postgres enum types
**Date:** 2026-09-16 · **Area:** Database

**Chosen:** Every closed value set (`materials.status`, `quiz_questions.question_type`,
`learning_events.event_type`, …) is `text` with a `CHECK (col in (...))`
constraint rather than a `CREATE TYPE ... AS ENUM`.

**Why:** Enums are marginally tidier but painful to evolve — removing or
reordering a value needs a type rewrite, and `ALTER TYPE ... ADD VALUE` cannot
run inside a transaction with other DDL, which breaks single-migration atomicity.
Over a three-day build the event-type list in particular will grow several times.
A `CHECK` gives identical write-time safety and is a one-line migration to
change.

**Trade-off:** No generated TS union type from the database. Handled by defining
the unions once in `@asc/shared` and having zod schemas validate at the boundary,
which we need anyway for AI output.

---

## D-009 — `user_id` denormalized onto every descendant table
**Date:** 2026-09-16 · **Area:** Security / Performance

**Chosen:** `material_chunks`, `messages`, `quiz_questions` and every other
descendant carry `user_id` directly, even though it is derivable by walking up
to `projects`.

**Why:** This is primarily a *security* decision, not a performance one. Every
RLS policy becomes `user_id = (select auth.uid())` — one line, no joins, and an
auditor can verify isolation on a table by reading a single predicate. The
alternative is a policy containing a subquery to `projects`, which is both
slower on every row and much easier to get subtly wrong. Isolation is a core PRD
requirement (§15), so the policies should be boring.

**Trade-off:** The redundant column can drift if a writer sets it wrong. Mitigated
by the fact that all writes go through a small number of service functions, and
by the isolation tests in task 3.

---

## D-010 — RLS enabled in the schema migration, policies in a later one
**Date:** 2026-09-16 · **Area:** Security

**Chosen:** Each `CREATE TABLE` migration ends with `ENABLE ROW LEVEL SECURITY`,
while the policies themselves land in a separate migration.

**Why:** RLS on with zero policies denies everything. Doing it in this order
means there is never a moment — not even between two migrations — where a table
exists and is readable through the auto-generated PostgREST API. The reverse
order leaves exactly that window open.

**Cost:** The Supabase advisor reports 19 `rls_enabled_no_policy` INFO notices
until task 3 lands. That is the expected state, not a finding.

---

## D-011 — Revoked EXECUTE on SECURITY DEFINER trigger functions
**Date:** 2026-09-16 · **Area:** Security

**Found by:** Supabase security advisor (lints 0028 / 0029), run immediately
after the schema migrations.

**Problem:** Postgres grants `EXECUTE` on new functions to `PUBLIC` by default,
and PostgREST exposes the whole `public` schema. That silently published
`handle_new_user()`, `touch_updated_at()` and `is_admin()` as live RPC endpoints
at `/rest/v1/rpc/<name>`, callable by anyone holding the anon key.
`handle_new_user()` is `SECURITY DEFINER` and writes to `public.profiles`.

**Fix:** `REVOKE EXECUTE ... FROM public, anon, authenticated` on both trigger
functions. Triggers are unaffected — a trigger function runs as part of the
triggering statement and needs no grant on the invoking role.

**Accepted remaining finding:** `is_admin()` stays executable by `authenticated`.
RLS policy expressions are evaluated as the querying role, so the policies in
task 3 require that grant. It discloses nothing: it answers "am I an admin?"
about the caller only. `anon` was revoked.

**Lesson worth keeping:** the default grant is the dangerous part. Any future
`public`-schema function needs an explicit revoke unless it is deliberately a
public endpoint.

---
