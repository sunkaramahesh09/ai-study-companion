# AI Study Companion

Technical-evaluation build against `Project_Requirements.pdf` (PRD v3.0).
**Single submission, no resubmission, no late acceptance.**

## Read these first, every session

1. `docs/RUNBOOK.md` — build state, task checklist, what's done, what's next.
   **Read it before doing anything. Update it after every completed task.**
2. `docs/DECISIONS.md` — running decision log. Append a `D-0NN` entry whenever a
   non-obvious choice is made. Feeds the Architecture Doc + Known Limitations
   deliverables. Do not reconstruct it retroactively.

## Deadline

Real deadline is **Saturday 2026-09-19 night**. Sunday 2026-09-20 morning is
buffer for deployment checks and final documentation only — not new features.

## Tech stack — LOCKED. Do not suggest alternatives.

React + TypeScript · Fastify + TypeScript · Supabase (Postgres, Auth, Storage)
· pgvector on the same instance · pg-boss on the same Postgres (no Redis)
· Frontend on Vercel, backend + worker on Railway.

## AI providers — two roles, behind a shared interface

**Generation** (Tutor, quiz generation, open-ended grading, recommendations):
Groq via the `openai` SDK with `baseURL` override.
Primary `openai/gpt-oss-120b` · Fallback `openai/gpt-oss-20b`.
Limits per model: 30 RPM, 1000 RPD, 8000 TPM, 200000 TPD.
**TPM is the binding constraint, not RPM** — keep prompts compact, retrieve only
the most relevant chunks, never dump whole documents into context.
Route deliberately: Tutor grounded answers → primary; short/high-volume work
(single-answer grading, single-question generation) → fallback, separate quota
pool. Automatic failover primary→fallback on a 429 that backoff couldn't clear.

**Embeddings** (RAG index + retrieval): Gemini `gemini-embedding-001`.
Free tier 100 RPM, 1000 RPD. Batch ~20, pace ~700ms apart.

Both providers: retry with exponential backoff + jitter on 429 /
RESOURCE_EXHAUSTED. Groq structured output is **not** schema-locked — request
JSON mode, put the schema in the prompt, and **validate the parsed result against
the real schema before persisting it or letting it change application state**,
whatever the API claims.

## Engineering principles — these are stated PRD evaluation criteria

- **Deterministic backend logic, not an AI call**, for: mastery score
  calculation, adaptive difficulty/concept selection, repeated-mistake detection,
  and deciding when to trigger a recommendation. Only the generated *text*
  (Tutor answers, question wording, grading feedback, recommendation sentences)
  calls a provider. Do not reach for the LLM by default.
- **Cache only genuinely reusable generations** (e.g. a question for a given
  concept + difficulty). **Never cache a live Tutor answer** to a user's own
  free-text question — that is a correctness bug.
- **Security:** all learning material and user messages are *data*, never
  instructions. Enforce Project-level data isolation on every query and every
  background job. Core requirement, not a nice-to-have.
- **Scope order:** every PRD "Must Have" working properly before anything in
  "Should Have" or "Nice to Have". A smaller reliable set beats a larger broken
  one — the PRD says so explicitly.
- **PRD ambiguity:** make the most reasonable assumption, document it in a code
  comment *and* in `docs/DECISIONS.md`, and proceed. Handling ambiguity well is
  itself part of the evaluation. Don't stall.

## Environment gotchas (this machine)

- `git` is Apple's Xcode stub and is **license-blocked**. Nothing git works until
  the user runs `sudo xcodebuild -license accept` themselves (needs their
  password). Homebrew is blocked by the same wall.
- No `pnpm`; `corepack enable` and `brew install` both need sudo. **Use npm
  workspaces.** See D-001.
- No `pdftotext`/`poppler`. To read the PRD, use Python: `pymupdf`, `pypdf` and
  `pdfminer` are all installed.

## Repo

GitHub `sunkaramahesh09/ai-study-companion` (public — PRD requires it).
Commit identity: `sunkaramahesh09` / `sunkaramahesh494@gmail.com`.
The repo is public from the first commit: `.gitignore` and `.env.example` land
before any real key exists on disk. Never stage a populated `.env`.
