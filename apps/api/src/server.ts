import Fastify from 'fastify';
import cors from '@fastify/cors';
import { corsOrigins, loadEnv } from './env.ts';

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

  await app.register(cors, { origin: corsOrigins(env), credentials: true });

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
