// Declared here rather than as a Railway variable so the quota split (D-022)
// cannot be silently lost by a misconfigured service. Must be set before any
// module reads it.
process.env.ASC_ROLE = 'worker';

import { PgBoss } from 'pg-boss';
import { loadEnv } from './env.ts';

/**
 * Background worker entrypoint (D-002).
 *
 * Every job payload carries its own ownership context (user_id + project_id).
 * The worker runs with the Supabase service role, which bypasses RLS, so
 * isolation here is the handler's responsibility: filter explicitly on the
 * payload's ids and never widen a query to "all projects". The PRD calls this
 * out directly — "Background jobs must preserve ownership context" (§15).
 */
export async function buildWorker(): Promise<PgBoss> {
  const env = loadEnv();

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Keep pg-boss's bookkeeping out of the application schema.
    schema: 'pgboss',
    // Supabase's pooler is the shared bottleneck; the worker should not be the
    // reason the API can't get a connection.
    max: 4,
  });

  boss.on('error', (err: Error) => {
    console.error('[worker] pg-boss error', err);
  });

  return boss;
}

async function main() {
  const boss = await buildWorker();
  await boss.start();
  console.log('[worker] started');

  // Job handlers register here as the pipeline lands:
  //   task 8  — material.process   (PDF extract → chunk → embed → ready)
  //   task 17 — quiz.completed     (evaluate → mastery → weakness → recommend)
  //   task 19 — recommendation.generate

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining jobs`);
    // Let in-flight handlers finish; a half-run indexing job that gets killed
    // mid-write is exactly the duplicate-state problem the PRD warns about.
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
