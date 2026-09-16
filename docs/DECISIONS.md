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

## D-012 — Isolation enforced in Postgres, verified against the real database
**Date:** 2026-09-16 · **Area:** Security

**Chosen:** RLS policies in Postgres are the isolation boundary, not API-layer
checks. The API calls Supabase with the *caller's* JWT, so every query is
filtered by the database. The worker uses the service role (which bypasses RLS)
and therefore carries `user_id` + `project_id` in each job payload and filters
explicitly.

**Why in the database:** an API-layer `where user_id = ...` is one forgotten
clause away from a leak, and the PRD calls isolation a core requirement. In
Postgres the check cannot be forgotten by a route that queries the table.

**Why the tests hit the real database:** RLS lives in Postgres, so a mocked test
proves nothing about it. `isolation.test.ts` creates two real users, signs both
in with real JWTs, and has user B attempt every read and write path against user
A's rows. It also asserts that A *can* read A's data — without that, a total
outage would make every isolation assertion pass for the wrong reason.

**Covered:** cross-user select (list and by-id), writing into another user's
space, forging a row under another user's id, update, delete, privilege
escalation, non-admin access to platform eval data, and direct writes to
backend-only tables. 12 cases, all green.

**Two findings this surfaced while writing it:**

1. *A policy on `user_id` alone is not enough for child inserts.* User B could
   satisfy `user_id = auth.uid()` while pointing `space_id` at user A's space.
   Child inserts now also assert `owns_space()` / `owns_project()`.

2. *RLS governs rows, not columns.* `id = auth.uid()` on `profiles` would let
   any user set their own `role` to `'admin'`. Postgres ignores a column-level
   REVOKE while table-level UPDATE is held, so the table grant is dropped and
   replaced with an explicit allowlist: `GRANT UPDATE (full_name)`. There is a
   test for the escalation attempt and one confirming the allowed column still
   works.

**Simplified:** No per-Space sharing or collaboration. Every row has exactly one
owner, which makes every policy a single equality check. Multi-user Projects
would need a membership table and a different policy shape throughout.

---

## D-013 — Accepted: ownership helpers are callable by signed-in users
**Date:** 2026-09-16 · **Area:** Security

**Finding:** The Supabase advisor (lint 0029) reports that `is_admin()`,
`owns_space(uuid)` and `owns_project(uuid)` are `SECURITY DEFINER` functions
executable by `authenticated` via `/rest/v1/rpc/<name>`.

**Accepted, deliberately.** RLS policy expressions are evaluated as the querying
role, so the policies in 0006 require `authenticated` to hold EXECUTE. `anon`
and `PUBLIC` were revoked from all three.

**Why it is not a leak:** each returns a boolean about *the caller only*.
`owns_project(id)` answers "do you own this?" and returns `false` identically
for "that project belongs to someone else" and "no such project exists" — so it
cannot be used as an existence oracle to enumerate ids. `is_admin()` answers
"are you an admin?" about yourself.

**Considered and rejected:** switching them to `SECURITY INVOKER`. It would
clear the warning, and would probably work, since the `spaces` and `projects`
SELECT policies would scope the lookup correctly. But it makes the isolation
layer depend on RLS evaluated inside RLS, which is subtler to reason about, in
exchange for silencing a warning with no exploit path. Not a trade worth making
three days from a single-shot deadline with the isolation suite already green.

**With more time:** revisit under test — flip to INVOKER and confirm all 12
isolation cases still pass.

---

## D-014 — AI provider keys required in production, optional elsewhere
**Date:** 2026-09-16 · **Area:** Configuration

**Chosen:** `GROQ_API_KEY` and `GEMINI_API_KEY` may be empty when
`NODE_ENV !== 'production'`. In production a `superRefine` rejects the boot.
Code paths that genuinely need a key call `requireProviderKey()`, which throws a
message naming the variable and `.env.example`.

**Why:** the original schema required both at boot, which meant the auth test
suite could not start the server — authentication has nothing to do with Groq.
Coupling every feature's startup to every provider's configuration makes local
development and CI unnecessarily brittle.

**Why production still fails fast:** a deployed instance missing a key would
pass its healthcheck and only fail on a user's first Tutor request. That is
strictly worse than refusing to start.

**Found by:** the auth tests, which could not boot the server on a machine with
no provider keys yet.

---

## D-015 — Authentication in one database round trip
**Date:** 2026-09-16 · **Area:** Performance / Security

**Chosen:** `requireAuth` decodes the JWT's `sub` claim locally *without*
verifying it, then reads that profile row through the caller's own RLS-scoped
client. Postgres validates the signature, expiry and issuer before returning
anything.

- forged or expired token → no row → 401
- a row coming back is itself proof the token is genuine
- `role` arrives from the database in the same trip

**Replaced:** `auth.getUser(token)` followed by a service-role profile read.
Two sequential network calls on *every* request (~300ms measured), and the
service role key — which bypasses RLS — sitting in the hot path of ordinary
request handling.

**Why the unverified decode is safe:** nothing trusts it on its own. It only
selects *which row to ask for*; the database does the verifying. The helper is
named `unsafeDecodeSubject` and documents that it must never back an
authorization decision without the accompanying round trip.

**Security gain, not just latency:** the service role key is now absent from
request handling entirely. It is used only by the worker and by explicitly
platform-level reads.

**Role is never read from a token claim.** `profiles.role` is authoritative, so
demoting a user takes effect on their next request even though they still hold a
valid JWT. There is a test that demotes an admin mid-session and asserts the
next call returns 403.

---

## D-016 — gpt-oss models are reasoning models; reasoning tokens spend the TPM budget
**Date:** 2026-09-16 · **Area:** AI / Cost

**Found by:** the first live Groq smoke call, which returned an **empty string**.

**What is happening:** `openai/gpt-oss-120b` and `-20b` emit internal reasoning
tokens before producing content, and those tokens are billed as completion
tokens. Measured on the prompt "Reply with the single word: ready":

| Setting | completion | of which reasoning | content |
|---|---|---|---|
| `max_tokens: 10` | 10 | 8 | `""` — truncated before any content |
| default effort, `max_tokens: 200` | 37 | 27 (73%) | `"ready"` |
| `reasoning_effort: 'low'` | 18 | 8 (44%) | `"ready"` |

**Two consequences:**

1. **This is a silent-failure mode, not just a cost issue.** Too low a
   `max_tokens` returns `""` with `finish_reason` set and no error. Downstream,
   `JSON.parse("")` throws somewhere unrelated to the real cause. The provider
   wrapper must set a floor on `max_tokens` that leaves room for reasoning, and
   must treat empty content as an explicit `invalid_output` failure rather than
   letting it propagate.

2. **The 8000 TPM ceiling is tighter than it looks.** Budget accounting has to
   include reasoning tokens, because the API bills them. A naive estimate based
   on prompt size plus expected answer length will under-count by roughly 2-3x.

**Decision:** `reasoning_effort` becomes an explicit part of the routing policy,
alongside model choice:
- Tutor grounded answers → default effort (reasoning earns its cost there)
- single-answer grading, single-question generation → `'low'`
- `ai_requests.completion_tokens` records the total including reasoning, so the
  admin cost view reflects what is actually spent.

**Confirmed from response headers:** `x-ratelimit-limit-tokens: 8000`,
`x-ratelimit-limit-requests: 1000` — matching the documented limits. These
headers are per-response and will be used to drive the limiter rather than
relying on a hardcoded guess.

---

## D-017 — Gemini's 768-dim vectors are NOT normalized; we normalize before storing
**Date:** 2026-09-16 · **Area:** Retrieval

**Found by:** live embedding smoke call.

**Measured:** a `gemini-embedding-001` embedding requested at
`outputDimensionality: 768` comes back with an **L2 norm of 0.581**, not 1.0.
Only the native 3072-dim output is normalized; MRL truncation drops magnitude
and Google does not re-normalize for you.

**Why it matters:** `material_chunks.embedding` is indexed with
`vector_cosine_ops`. Cosine distance divides by vector magnitudes, so
unnormalized vectors of varying length still *rank* roughly correctly, but the
distance values themselves become incomparable between chunks. The evidence
sufficiency gate for unsupported-question handling (task 11) thresholds on an
absolute distance — with unnormalized vectors that threshold means something
different for every chunk, which would quietly break the PRD's core
"don't fabricate" requirement.

**Decision:** normalize every embedding to unit length at write time *and* at
query time, in the embedding provider itself so no caller can forget. D-004
flagged this as a risk; this confirms it is real and measured, not theoretical.

**Test to write with task 7:** assert that every vector returned by the
embedding provider has an L2 norm of 1.0 within floating-point tolerance.

---

## D-018 — Never `npx` a build tool in CI; assert the build produced output
**Date:** 2026-09-16 · **Area:** Deployment

**Found by:** building the Docker image locally before creating any hosting
account — which is the entire reason task 5 was scheduled on night one.

**Two independent bugs, both silent, both would have shipped:**

1. **`npx tsc` downloaded the wrong package.** With TypeScript not resolvable at
   that moment, `npx` helpfully fetched an unrelated registry package literally
   named `tsc` (v2.0.4, deprecated since 2017), printed a banner, **exited 0**,
   and compiled nothing. Fixed by using `npm run build --workspace=...`, which
   resolves from `node_modules/.bin` and fails loudly.

2. **`.dockerignore` had `*.tsbuildinfo`, which only matches the root level.**
   Nested `packages/*/tsconfig.tsbuildinfo` were copied into the image from the
   host. TypeScript read that stale incremental state, concluded every project
   was up to date, and skipped emitting — while `dist` was (correctly) excluded
   by the same file. Fixed with `**/*.tsbuildinfo`.

**The shared failure mode:** both produced an image that built successfully and
contained no application code. Neither surfaced until runtime, as a crash loop
on a platform, which is a miserable thing to debug on a deadline.

**Decision:** the Dockerfile asserts its own output before the runtime stage —
every `dist/` directory must exist, and `server.js` and `worker.js` must be
present, or the build fails. A build step that can succeed while producing
nothing needs a guard, not trust.

**Verified locally before any account existed:** image builds (364MB), API boots
in production mode against the real database and serves `/health`, `/api/me`
still returns 401 without a token, the container runs as the unprivileged `node`
user, the worker entrypoint starts and pg-boss creates its schema in Postgres,
and SIGTERM drains cleanly with exit code 0.

---

## D-019 — Vercel installs production-only; build tools must be requested explicitly
**Date:** 2026-09-16 · **Area:** Deployment

**Symptom:** Vercel build failed with `sh: line 1: tsc: command not found`,
exit 127.

**Cause:** Vercel sets `NODE_ENV=production` for builds, and `npm ci` honours
that by omitting `devDependencies`. TypeScript and Vite are devDependencies —
correctly so, since they are build tools, not runtime dependencies — so the
build tools were absent from the machine asked to run the build. The package
count was the tell: **129 installed on Vercel vs 219 locally.**

**Fix:** `installCommand: "npm ci --include=dev"` in `vercel.json`.

**Why not the alternative:** setting `NPM_CONFIG_PRODUCTION=false` in the Vercel
dashboard would also work, but it is invisible configuration living outside the
repository. Anyone cloning this project would hit the same failure with no clue
why. The `vercel.json` version travels with the code.

**Reproduced locally before pushing**, rather than redeploying to find out:
`NODE_ENV=production npm ci` on a clean `git archive` of HEAD → 135 packages,
no `tsc` binary, failure reproduced. With `--include=dev` → 220 packages, `tsc`
and `vite` both present, and `npm run build --workspace=@asc/web` succeeds.

**Related to D-018.** Third deployment footgun in one evening, all the same
shape: a build that behaves differently on the platform than on the developer
machine, and fails in a way that does not name its real cause. The general
lesson is to reproduce the platform's conditions locally instead of iterating
through redeploys — each remote round trip costs minutes, each local one costs
seconds.

---

## D-020 — Every workspace declares its own build tools
**Date:** 2026-09-16 · **Area:** Deployment

**Chosen:** `typescript` is a devDependency of `apps/web`, `apps/api`,
`packages/shared` and `packages/ai` individually, not only of the workspace
root. `vite` likewise stays declared in `apps/web`.

**Why:** the fix in D-019 (`npm ci --include=dev`) only helps when the install
runs at the workspace root. Vercel's "Root Directory" setting changes the
working directory for both install and build, and when it points at `apps/web`
the root `vercel.json` is not read at all — so the install command, the build
command and the output directory all silently revert to Vercel's own defaults.
A package that cannot build from its own directory is a package that depends on
a setting living in someone's dashboard.

**Verified both ways before pushing**, on a clean copy of the tree:
- install + build from the repo root → 220 packages, build succeeds
- install + build from inside `apps/web` → 89 packages, `tsc` still resolves,
  build succeeds

**Correct Vercel configuration** is still Root Directory = repository root, so
`vercel.json` governs. This change means the build no longer *depends* on that
being right.

**Cost:** the same version string is repeated in five manifests and they must be
bumped together. Pinned exactly (`5.9.3`, per D-003) so a drift between
workspaces is a visible diff rather than a silent resolution difference.

---

## D-021 — A schemeless API base URL fails silently; normalize it and guard the response
**Date:** 2026-09-16 · **Area:** Frontend / Reliability

**Found by:** inspecting the deployed Vercel bundle after the first production
deploy — the Railway hostname was present but with no `https://` in front of it.

**Why it is worse than a normal misconfiguration:** `fetch()` treats a
schemeless value as a *relative path*. So `VITE_API_BASE_URL` set to
`api.example.com` makes every call resolve against the frontend's own origin,
where the SPA rewrite in `vercel.json` answers it with `index.html` and
**HTTP 200**. Nothing throws at the network layer. The app receives a
"successful" response, and the failure only appears later as a JSON parse error
with no connection to the actual cause.

**Two defences:**

1. `normalizeBaseUrl()` prepends `https://` when the scheme is missing and warns
   in the console. Assuming https is the correct recovery — the only realistic
   cause is a deploy variable set to a bare hostname, and there is no case where
   a schemeless absolute host should resolve against the frontend origin. Empty
   stays empty, since same-origin deployments legitimately call `/api/...`.

2. `api()` rejects any 2xx response whose content-type is not JSON, with a
   message naming the likely cause. A misrouted request answered by the frontend
   host now fails immediately and explains itself.

**Kept the config fix too.** The deployment variable still needs the scheme; the
code change exists so this class of mistake announces itself instead of
producing a green deploy and a confusing runtime error.

---

## D-022 — Rate limits are enforced per process, with the quota split between services
**Date:** 2026-09-17 · **Area:** AI / Reliability

**Problem:** the limiter lives in memory, but the API and the worker are two
separate Railway services. Neither can see the other's usage, so if both are
configured with the full 8000 TPM they will collectively spend up to 16000 and
collect 429s from a provider that is, from each process's point of view, well
within budget.

**Chosen:** each process takes a `quotaShare` of the documented limits, and the
shares sum to 1:

| | Groq | Gemini |
|---|---|---|
| worker | 0.60 | 0.90 |
| api | 0.40 | 0.10 |

The worker does the bulk work — document indexing, quiz completion workflows —
so it takes most of the embedding budget and the larger share of generation. The
API serves interactive Tutor traffic, which is latency-sensitive but low volume.

**Rejected: a Postgres-backed shared limiter.** It would be exact, and we
already have the database. But every provider call would then need a transaction
and an advisory lock before it could start, adding a round trip to the critical
path of every Tutor answer, plus a new failure mode when that lock is contended.
For a prototype with one user demoing it, a static split is the better trade.

**Known limitation (goes in the deliverable):** the split is static, so if the
worker is idle the API cannot borrow its headroom. Under real multi-user load
this should become a shared limiter — Postgres-backed, or Redis if the stack
allowed it. The failover to the fallback model (a separate quota pool) softens
the impact in the meantime.

**Second limitation:** the window is in memory, so a deploy or restart forgets
recent usage and the process may briefly exceed its share. Retry with backoff
plus failover covers this; a durable counter would not be worth the complexity
here.

---

## D-023 — Empty model output is a failure, not an empty answer
**Date:** 2026-09-17 · **Area:** AI / Reliability

**Chosen:** `GroqProvider` treats a blank `content` as `InvalidOutputError`,
records the attempt as `invalid_output` in `ai_requests`, and includes the
reasoning-token count in the message. `max_completion_tokens` is also floored at
256.

**Why:** gpt-oss spends completion tokens on reasoning *before* emitting
content, so a low token ceiling truncates the response to `""` — with HTTP 200,
a `finish_reason`, and no error anywhere (D-016; measured at `max_tokens: 10`).
Passed along, that empty string reaches `JSON.parse("")` and throws somewhere
with no connection to the real cause. Failing at the provider boundary, with a
message that names both the cause and the fix, turns a baffling downstream
crash into a one-line diagnosis.

**Same reasoning as D-021** (non-JSON 2xx responses) and the Dockerfile output
assertion (D-018): where a component can fail while appearing to succeed, add
the check at the boundary rather than trusting the happy path.

---

## D-024 — RLS-filtered reads return 404, not 403
**Date:** 2026-09-17 · **Area:** Security / API

**Chosen:** when a caller requests a resource they do not own, the API returns
`404 not_found`. `403` is reserved for a caller who is authenticated and whose
role is insufficient — the admin routes.

**Why:** answering `403` confirms that the id exists. An attacker enumerating
UUIDs could separate "no such project" from "someone else's project", which is a
disclosure even though no content leaks. From the database's point of view the
row genuinely does not exist for this caller, because RLS filtered it out, so
`404` is also the honest answer rather than a deliberate lie.

**Implementation detail:** PostgREST reports an RLS-filtered single-row read as
`PGRST116` ("no rows"), which maps cleanly to 404. Deletes are trickier — a
filtered delete affects zero rows and reports success, so every delete selects
the affected ids back and returns 404 when none came through. Otherwise the API
would tell Bob it had deleted Alice's project.

---

## D-025 — Ownership comes from the token; body fields are ignored
**Date:** 2026-09-17 · **Area:** Security / API

**Chosen:** `user_id` on every insert is taken from `req.user.id`, established
by the auth plugin from the verified JWT. Request bodies are parsed with zod
schemas that do not include `user_id`, so a client-supplied value is dropped
before it reaches the database.

**Why:** mass-assignment is the classic version of this bug — trusting a body
field that happens to share a name with a column. There is a test that posts
`user_id: <another user's id>` and asserts the created row belongs to the
caller instead.

**Defence in depth:** even if a handler did pass it through, the RLS
`WITH CHECK` on every insert requires `user_id = auth.uid()`, so the database
would reject it. Two independent layers, because isolation is a core PRD
requirement (§15).

---
