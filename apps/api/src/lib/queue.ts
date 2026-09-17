import { PgBoss } from 'pg-boss';
import { loadEnv } from '../env.ts';

/**
 * Job queue names. One place so a producer and a consumer cannot disagree about
 * a string literal.
 */
export const QUEUES = {
  materialProcess: 'material.process',
  materialConcepts: 'material.concepts',
} as const;

export type MaterialProcessJob = {
  materialId: string;
  /**
   * Ownership travels WITH the job. The worker runs with the service role,
   * which bypasses RLS, so it cannot rely on the database to scope its queries
   * — it filters on these explicitly. The PRD requires it: "Background jobs
   * must preserve ownership context" (§15).
   */
  userId: string;
  projectId: string;
};

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

/**
 * Lets the worker donate its own already-started pg-boss instance.
 *
 * Without this, a job handler that enqueues follow-up work (material.process
 * chaining material.concepts) would spin up a SECOND pg-boss inside the worker
 * process — a second connection pool against the same Supabase pooler, and a
 * set of handles that keeps the process alive after the work is done.
 */
export function setQueueInstance(instance: PgBoss): void {
  boss = instance;
  starting = Promise.resolve(instance);
}

/**
 * pg-boss client for the API side, used only to SEND jobs. The worker owns its
 * own instance and does the consuming (D-002).
 */
export async function queue(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const env = loadEnv();
    const instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.PGBOSS_SCHEMA,
      // The API only publishes, so it needs very few connections. Supabase's
      // pooler is shared, and the worker needs the headroom more.
      max: 2,
      // Maintenance is the worker's job; two schedulers would duplicate work.
      supervise: false,
    });
    instance.on('error', (err: Error) => console.error('[queue] pg-boss error', err));
    await instance.start();
    // pg-boss 12 requires a queue to exist before a job can be sent to it.
    // Idempotent, so both the API and the worker can safely call it on boot.
    for (const name of Object.values(QUEUES)) {
      await instance.createQueue(name).catch(() => {});
    }
    boss = instance;
    return instance;
  })();
  return starting;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = undefined;
    starting = undefined;
  }
}

/**
 * Enqueues document processing.
 *
 * `singletonKey` is the materialId, so a double-submit or a retried request
 * cannot queue the same document twice. Combined with the unique
 * (material_id, chunk_index) constraint, a re-run can neither duplicate a job
 * nor duplicate chunks.
 */
/**
 * Enqueues concept extraction. Separate from processing so a rate-limited LLM
 * call cannot mark an indexed document failed — see jobs/materialConcepts.ts.
 */
export async function enqueueMaterialConcepts(job: MaterialProcessJob): Promise<string | null> {
  const b = await queue();
  return b.send(QUEUES.materialConcepts, job, {
    singletonKey: job.materialId,
    retryLimit: 3,
    retryBackoff: true,
    // Longer than processing: a 429 from Groq may need a full minute to clear.
    retryDelay: 60,
    expireInSeconds: 900,
  });
}

export async function enqueueMaterialProcess(job: MaterialProcessJob): Promise<string | null> {
  const b = await queue();
  return b.send(QUEUES.materialProcess, job, {
    singletonKey: job.materialId,
    retryLimit: 3,
    // Exponential so a transient provider outage is not hammered.
    retryBackoff: true,
    retryDelay: 30,
    // A stuck handler is released back to the queue after this, rather than
    // leaving the material in 'processing' forever.
    expireInSeconds: 900,
  });
}
