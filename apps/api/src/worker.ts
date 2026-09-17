// Declared here rather than as a Railway variable so the quota split (D-022)
// cannot be silently lost by a misconfigured service. Must be set before any
// module reads it.
process.env.ASC_ROLE = 'worker';

import { PgBoss } from 'pg-boss';
import { loadEnv } from './env.ts';
import { QUEUES, setQueueInstance, type MaterialProcessJob } from './lib/queue.ts';
import { processMaterial } from './jobs/materialProcess.ts';
import { extractMaterialConcepts } from './jobs/materialConcepts.ts';
import { handleQuizCompleted, type QuizCompletedJob } from './jobs/quizCompleted.ts';

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
    schema: env.PGBOSS_SCHEMA,
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

  // Handlers that chain follow-up jobs publish through lib/queue.ts; point it
  // at this instance so the worker does not open a second pg-boss.
  setQueueInstance(boss);

  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name).catch(() => {});
  }

  // Concurrency of 2: document processing is IO-bound (download, extract) but
  // task 9 adds embedding calls, which are rate-limited per process (D-022).
  // Running many in parallel would just queue behind the limiter.
  await boss.work<MaterialProcessJob>(
    QUEUES.materialProcess,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      console.log('[worker] material.process', job.data.materialId);
      await processMaterial(job.data);
    },
  );
  console.log('[worker] handler registered: ' + QUEUES.materialProcess);

  await boss.work<MaterialProcessJob>(
    QUEUES.materialConcepts,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      console.log('[worker] material.concepts', job.data.materialId);
      await extractMaterialConcepts(job.data);
    },
  );
  console.log('[worker] handler registered: ' + QUEUES.materialConcepts);

  await boss.work<QuizCompletedJob>(
    QUEUES.quizCompleted,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      console.log('[worker] quiz.completed', job.data.attemptId);
      await handleQuizCompleted(job.data);
    },
  );
  console.log('[worker] handler registered: ' + QUEUES.quizCompleted);

  // Further handlers land with their tasks.

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
