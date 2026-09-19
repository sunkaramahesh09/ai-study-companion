import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { corsOrigins, loadEnv } from './env.ts';
import authPlugin from './plugins/auth.ts';
import { materialRoutes } from './routes/materials.ts';
import { meRoutes } from './routes/me.ts';
import { projectRoutes } from './routes/projects.ts';
import { adminRoutes } from './routes/admin.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { flashcardRoutes } from './routes/flashcards.ts';
import { growthRoutes } from './routes/growth.ts';
import { quizRoutes } from './routes/quiz.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { tutorRoutes } from './routes/tutor.ts';

/**
 * API entrypoint. The pg-boss worker is a sibling entrypoint (worker.ts) in
 * this same package, deployed as a second Railway service from the same
 * image — see D-002.
 */
export async function buildServer() {
  const env = loadEnv();

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Supabase JWTs and PDF metadata both push past Fastify's tiny default.
    bodyLimit: 1_048_576,
  });

  /**
   * `methods` is explicit because the default is NOT what the app needs.
   *
   * Left unset, @fastify/cors advertises only the CORS-safelisted methods:
   * `access-control-allow-methods: GET,HEAD,POST`. The browser then blocks
   * every PATCH and DELETE at the preflight, so in production the request
   * never leaves the page — it surfaces as a network-level fetch rejection
   * with no status and no server log, because the server was never asked.
   *
   * That silently broke every edit and every delete in the app: dismissing a
   * recommendation, renaming a space or project, removing a material. See
   * D-058.
   *
   * Nothing caught it, because CORS is enforced by the BROWSER. Every test
   * here uses `app.inject`, and the production rehearsal uses Node's fetch —
   * neither enforces CORS. `scripts/rehearse-production.mjs` now preflights
   * each method the app actually uses.
   */
  /**
   * Treat an empty `application/json` body as `{}` instead of a 400.
   *
   * Fastify's default JSON parser raises FST_ERR_CTP_EMPTY_JSON_BODY when a
   * request declares JSON and sends nothing. That is defensible, but it fires
   * in the body parser — before the route and before auth — so a body-less
   * POST to an endpoint that needs no body fails with a confusing 400 that
   * never reaches the handler.
   *
   * Several endpoints here legitimately take no body: `/materials/:id/retry`,
   * `/quizzes/:id/abandon`, `/quizzes/:id/next`, `/projects/:id/touch`. A
   * client that sets the header out of habit should not be punished for it;
   * the route's own zod schema is what decides whether the payload is valid.
   *
   * The web client no longer sends the header without a body either (D-060) —
   * this is the second layer, for every other consumer.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim();
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      // Malformed JSON stays a client error, as it should be.
      done(Object.assign(new Error('Malformed JSON body.'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, {
    origin: corsOrigins(env),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  });
  // 25 MB matches the storage bucket's file_size_limit in migration 0007.
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(meRoutes);
  await app.register(spaceRoutes);
  await app.register(projectRoutes);
  await app.register(materialRoutes);
  await app.register(tutorRoutes);
  await app.register(quizRoutes);
  await app.register(flashcardRoutes);
  await app.register(growthRoutes);
  await app.register(analyticsRoutes);
  await app.register(adminRoutes);

  // Railway healthcheck. Deliberately does not touch the database: this answers
  // "is the process up", which is what a platform restart decision needs.
  // Dependency health belongs in the admin system-health view (task 21).
  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  return app;
}

async function main() {
  const env = loadEnv();
  const app = await buildServer();
  try {
    // 0.0.0.0, not localhost — Railway's proxy can't reach a loopback bind.
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err, 'failed to start api server');
    process.exit(1);
  }
}

// Only auto-start when run directly, so tests can import buildServer() freely.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
