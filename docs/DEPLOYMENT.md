# Deployment

## Live environment

| Service | URL |
|---|---|
| Frontend (Vercel) | https://ai-study-companion-ruby.vercel.app |
| API (Railway) | https://ai-study-companion-production-a07f.up.railway.app |
| Worker (Railway) | service `hospitable-light` — no public domain, by design |
| Database (Supabase) | project `maeifbzqpehidwuprypv`, region `ap-south-1` |

Two gotchas cost real time on the first deploy, both worth knowing:

- **`VITE_API_BASE_URL` must include `https://`.** A bare hostname is treated by
  `fetch()` as a relative path, so every call resolves against the frontend
  origin, matches the SPA rewrite and returns `index.html` with HTTP 200 — a
  silent failure with no network error (D-021).
- **`CORS_ORIGINS` must be set to the Vercel URL** *after* the frontend exists.
  Until then the API answers preflights with 204 but sends no
  `access-control-allow-origin`, and the browser blocks every call.

Vite bakes `VITE_*` variables in at **build** time, so changing one in Vercel
requires a redeploy, not just a save.


Three services, two platforms, one database.

```
Vercel                Railway                        Supabase
┌──────────┐          ┌──────────┐  ┌──────────┐     ┌─────────────────┐
│ web      │──HTTPS──▶│ api      │  │ worker   │────▶│ Postgres 17     │
│ (static) │          │ Fastify  │  │ pg-boss  │     │ + pgvector      │
└──────────┘          └────┬─────┘  └────┬─────┘     │ + Auth          │
                           └─────────────┴──────────▶│ + Storage       │
                                                     └─────────────────┘
```

`api` and `worker` are the **same image** with different start commands (D-002).

Everything below was verified locally before any account was created: the image
builds, both entrypoints boot against the real database, pg-boss creates its
schema, and the container shuts down gracefully on SIGTERM.

---

## 0. Prerequisites

The Supabase project already exists — `maeifbzqpehidwuprypv`, region
`ap-south-1`. Migrations in `supabase/migrations/` are already applied.

You need, from **Supabase Dashboard → Project Settings**:
- API → Project URL, publishable (anon) key, service role key
- Database → connection string (URI form, with the password)

And provider keys: [Groq console](https://console.groq.com/keys),
[Google AI Studio](https://aistudio.google.com/apikey).

---

## 1. Railway — API service

1. New Project → **Deploy from GitHub repo** → `sunkaramahesh09/ai-study-companion`.
2. Railway detects the root `Dockerfile` automatically. No build command needed.
3. **Settings → Start Command:** leave empty (the image's `CMD` already runs the API).
4. **Settings → Networking → Generate Domain.** Note the URL.
5. **Settings → Healthcheck Path:** `/health`.
   It deliberately does not touch the database: this answers "is the process
   up", which is the question a platform restart decision needs. Database health
   belongs in the admin system-health view.
6. **Variables** — set these:

   ```
   NODE_ENV=production
   PORT=8080
   LOG_LEVEL=info
   SUPABASE_URL=https://maeifbzqpehidwuprypv.supabase.co
   SUPABASE_ANON_KEY=<publishable key>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   DATABASE_URL=<connection string>
   GROQ_API_KEY=<groq key>
   GEMINI_API_KEY=<gemini key>
   CORS_ORIGINS=<the Vercel URL, once step 3 is done>
   ```

   `NODE_ENV=production` matters: env validation refuses to boot without the
   provider keys in production (D-014), so a misconfigured deploy fails
   immediately rather than on a user's first Tutor request.

## 2. Railway — worker service

In the **same Railway project**, add a second service from the same repo.

- **Start Command:** `node apps/api/dist/worker.js`
- **Healthcheck:** none — it is not an HTTP server.
- **Variables:** identical to the API. `CORS_ORIGINS` and `PORT` are unused but
  harmless.

Two services, one image. The worker holds its own small connection pool
(`max: 4`) so background indexing cannot starve the API of connections.

## 3. Vercel — frontend

**Create exactly one Vercel project, and only for the frontend.**

Vercel scans the monorepo and offers to import `apps/api` as a second project
because it detects Fastify. Decline it. The API and worker belong on Railway:
Vercel runs ephemeral serverless functions, while the API is a long-lived
process bound to a port and the pg-boss worker is a polling loop holding a
connection pool — there is no request to trigger background indexing, so a
serverless worker cannot exist at all. Importing `apps/api` here would also
ignore the Dockerfile and the one-image-two-entrypoints design (D-002).

1. New Project → import the GitHub repo.
2. **Root directory: the repository root.** Not `apps/web`. Vercel only reads
   `vercel.json` from the configured root directory; point it at `apps/web` and
   the install command, build command and output directory all silently revert
   to Vercel's defaults, and the build fails with `tsc: command not found`
   (D-019, D-020).
3. **Application Preset: Other.** `vercel.json` sets `"framework": null` and
   specifies every command explicitly.
4. **Environment variables:**

   ```
   VITE_SUPABASE_URL=https://maeifbzqpehidwuprypv.supabase.co
   VITE_SUPABASE_ANON_KEY=<publishable key>
   VITE_API_BASE_URL=<the Railway API URL from step 1>
   ```

   Only `VITE_`-prefixed variables reach the browser bundle. The service role
   key must never appear here — it bypasses RLS.

5. Deploy, then **go back to Railway and set `CORS_ORIGINS` to the Vercel URL.**
   This is the step most easily forgotten; the symptom is a frontend that loads
   fine and fails every API call with an opaque CORS error.

## 4. Supabase — auth redirect URLs

**Authentication → URL Configuration:**
- Site URL: the Vercel production URL
- Redirect URLs: add the Vercel URL and `http://localhost:5173`

Without this, email confirmation links bounce back to localhost.

---

## Verification checklist

Run against the **deployed** URLs, not localhost:

```bash
curl -s https://<api>/health                      # {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}\n" \
     https://<api>/api/me                          # 401
```

Then in the browser: sign up, sign in, reload the page (the session must
survive), and confirm the dashboard shows "Backend session check:
authenticated". That single line exercises browser session → bearer token →
Fastify auth plugin → RLS-scoped profile read → response.

---

## Local development

```bash
npm install
cp .env.example .env     # fill in
npm run dev:api          # :8080
npm run dev:worker
npm run dev:web          # :5173
npm test
```

## Building the image locally

```bash
docker build -t asc-api .
docker run --rm -p 8080:8080 --env-file .env -e NODE_ENV=production asc-api
docker run --rm --env-file .env -e NODE_ENV=production asc-api node apps/api/dist/worker.js
```

Image is ~364MB and runs as the unprivileged `node` user.
