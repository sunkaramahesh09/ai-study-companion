# Deployment

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

1. New Project → import the same GitHub repo.
2. **Root directory:** leave at the repository root. `vercel.json` already sets
   the install command, build command and output directory for the monorepo.
3. **Environment variables:**

   ```
   VITE_SUPABASE_URL=https://maeifbzqpehidwuprypv.supabase.co
   VITE_SUPABASE_ANON_KEY=<publishable key>
   VITE_API_BASE_URL=<the Railway API URL from step 1>
   ```

   Only `VITE_`-prefixed variables reach the browser bundle. The service role
   key must never appear here — it bypasses RLS.

4. Deploy, then **go back to Railway and set `CORS_ORIGINS` to the Vercel URL.**
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
