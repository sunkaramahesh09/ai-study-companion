import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processMaterial } from '../jobs/materialProcess.ts';
import { serviceClient } from '../lib/supabase.ts';
import { stopQueue } from '../lib/queue.ts';
import { makePdf } from './fixtures/makePdf.ts';

/**
 * Background job failure, retry and recovery (PRD §13).
 *
 * The PRD asks for "reasonable job states, retries, failure handling, and
 * recovery", and that "operations that may be retried must avoid creating
 * duplicate state". Those are the two properties tested here, and they are only
 * observable end to end — a unit test of the handler would mock away the
 * database that makes duplication possible in the first place.
 *
 * The job handler is called directly rather than through a worker, so the test
 * owns the pipeline and cannot race a background process (landmine 2).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && GEMINI);
const describeLive = configured ? describe : describe.skip;

const JOB_TIMEOUT = 120_000;

describeLive('background job resilience', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId: string;
  let otherUserId: string;
  let projectId: string;

  async function makeUser(label: string) {
    const email = `jobs-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email, password: `Test!${Math.random().toString(36).slice(2, 12)}`, email_confirm: true,
    });
    if (error) throw new Error(error.message);
    return data.user!.id;
  }

  /** Inserts a material row and uploads its bytes, without processing it. */
  async function stageMaterial(bytes: Buffer, filename = 'Notes.pdf') {
    const materialId = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
    const up = await serviceClient()
      .storage.from('materials')
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    const { error } = await serviceClient().from('materials').insert({
      id: materialId, project_id: projectId, user_id: userId,
      filename, storage_path: storagePath, size_bytes: bytes.length, status: 'queued',
    });
    if (error) throw new Error(error.message);
    return { materialId, storagePath };
  }

  const readMaterial = async (id: string) =>
    (await serviceClient()
      .from('materials')
      .select('status, error_message, chunk_count, page_count, processed_at')
      .eq('id', id)
      .single()).data!;

  const countChunks = async (id: string) =>
    (await serviceClient()
      .from('material_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('material_id', id)).count ?? 0;

  beforeAll(async () => {
    [userId, otherUserId] = await Promise.all([makeUser('owner'), makeUser('other')]);
    const { data: space } = await serviceClient()
      .from('spaces').insert({ user_id: userId, name: 'Jobs' }).select('id').single();
    const { data: project } = await serviceClient()
      .from('projects').insert({ space_id: space!.id, user_id: userId, name: 'Jobs' }).select('id').single();
    projectId = project!.id;
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) if (id) await admin.auth.admin.deleteUser(id);
    await stopQueue();
  });

  it(
    'marks a material failed with a readable reason when its bytes are unreadable',
    async () => {
      // Not a PDF at all. The upload route rejects these by magic bytes, so
      // this is the corrupted-in-storage case — the one that reaches the job.
      const { materialId } = await stageMaterial(Buffer.from('this is not a pdf, not even slightly'));

      // The handler rethrows so pg-boss can apply its retry policy; the status
      // write is what the user sees in the meantime, and it must survive.
      await expect(processMaterial({ materialId, userId, projectId })).rejects.toThrow();

      const material = await readMaterial(materialId);
      expect(material.status).toBe('failed');
      expect(material.error_message).toBeTruthy();
      // A reason a person can act on, not a stack trace.
      expect(material.error_message.length).toBeLessThan(500);

      const { data: events } = await serviceClient()
        .from('learning_events')
        .select('event_type')
        .eq('project_id', projectId)
        .eq('event_type', 'material_failed');
      expect((events ?? []).length).toBeGreaterThanOrEqual(1);
    },
    JOB_TIMEOUT,
  );

  it(
    'recovers a failed material on retry once the problem is gone',
    async () => {
      // The stored object is missing: the DB row exists but the upload never
      // landed. This is the transient-infrastructure case the retry button is
      // for, and it recovers WITHOUT the user re-uploading.
      const materialId = crypto.randomUUID();
      const storagePath = `${userId}/${projectId}/${materialId}.pdf`;
      const { error } = await serviceClient().from('materials').insert({
        id: materialId, project_id: projectId, user_id: userId,
        filename: 'Missing.pdf', storage_path: storagePath, size_bytes: 1234, status: 'queued',
      });
      if (error) throw new Error(error.message);

      await expect(processMaterial({ materialId, userId, projectId })).rejects.toThrow();
      const failed = await readMaterial(materialId);
      expect(failed.status).toBe('failed');
      expect(failed.error_message).toBeTruthy();

      // The object appears. Note this is a CREATE at a path that had nothing —
      // never an overwrite, which Storage does not make visible (landmine 10).
      const good = makePdf([
        'Diffusion moves particles from a region of high concentration to one of low concentration.',
        'Osmosis is the diffusion of water across a selectively permeable membrane.',
      ]);
      const up = await serviceClient()
        .storage.from('materials')
        .upload(storagePath, good, { contentType: 'application/pdf', upsert: true });
      if (up.error) throw new Error(up.error.message);

      await processMaterial({ materialId, userId, projectId });

      const material = await readMaterial(materialId);
      expect(material.status).toBe('ready');
      // The stale failure message must be cleared, or the UI shows an error
      // beside a document that is working.
      expect(material.error_message).toBeNull();
      expect(material.chunk_count).toBeGreaterThan(0);
      expect(await countChunks(materialId)).toBe(material.chunk_count);
    },
    JOB_TIMEOUT,
  );

  it(
    'creates no duplicate chunks when the same job runs three times',
    async () => {
      const { materialId } = await stageMaterial(
        makePdf([
          'Mitosis produces two genetically identical daughter cells from one parent cell.',
          'Meiosis produces four genetically distinct gametes and halves the chromosome number.',
        ]),
      );

      await processMaterial({ materialId, userId, projectId });
      const afterFirst = await countChunks(materialId);
      expect(afterFirst).toBeGreaterThan(0);

      // The second and third runs short-circuit on status='ready'. That is the
      // cheap guard; the expensive one is the upsert key underneath it.
      await processMaterial({ materialId, userId, projectId });
      await processMaterial({ materialId, userId, projectId });

      expect(await countChunks(materialId)).toBe(afterFirst);
    },
    JOB_TIMEOUT,
  );

  it(
    'creates no duplicate chunks when a ready material is reprocessed from scratch',
    async () => {
      const { materialId } = await stageMaterial(
        makePdf(['Transcription copies DNA into messenger RNA inside the nucleus of the cell.']),
      );
      await processMaterial({ materialId, userId, projectId });
      const first = await countChunks(materialId);

      // Force the real path: the status guard is bypassed, so the upsert on
      // (material_id, chunk_index) is what has to prevent duplication.
      await serviceClient().from('materials').update({ status: 'queued' }).eq('id', materialId);
      await processMaterial({ materialId, userId, projectId });

      expect(await countChunks(materialId)).toBe(first);
      expect((await readMaterial(materialId)).status).toBe('ready');
    },
    JOB_TIMEOUT,
  );

  it(
    'deletes stale trailing chunks when a document shrinks',
    async () => {
      const { materialId } = await stageMaterial(
        makePdf([
          'Page one discusses the light-dependent reactions of photosynthesis in the thylakoid membranes.',
          'Page two discusses the Calvin cycle and carbon fixation in the stroma of the chloroplast.',
          'Page three discusses photorespiration and the conditions under which RuBisCO fixes oxygen.',
        ]),
      );
      await processMaterial({ materialId, userId, projectId });
      const before = await countChunks(materialId);
      expect(before).toBeGreaterThanOrEqual(3);

      // The row is pointed at a SHORTER document, at a new path. Upsert alone
      // would leave the old trailing chunks behind, and the Tutor would cite
      // pages that no longer exist in the file the learner can open.
      //
      // A new path rather than an overwrite, because Storage does not make an
      // in-place overwrite visible to a subsequent download (landmine 10) —
      // and because a new path is what the product itself does.
      const shorter = makePdf(['Only one page survives the replacement of this document.']);
      const newPath = `${userId}/${projectId}/${crypto.randomUUID()}.pdf`;
      const up = await serviceClient()
        .storage.from('materials')
        .upload(newPath, shorter, { contentType: 'application/pdf', upsert: true });
      if (up.error) throw new Error(up.error.message);
      await serviceClient()
        .from('materials')
        .update({ storage_path: newPath, status: 'queued' })
        .eq('id', materialId);

      await processMaterial({ materialId, userId, projectId });

      const after = await countChunks(materialId);
      expect(after).toBeLessThan(before);
      expect(after).toBe((await readMaterial(materialId)).chunk_count);
      // Nothing may still point past the end of the new document.
      const { data: pages } = await serviceClient()
        .from('material_chunks').select('page_number').eq('material_id', materialId);
      expect(Math.max(...(pages ?? []).map((p) => Number(p.page_number)))).toBe(1);
    },
    JOB_TIMEOUT,
  );

  it(
    'ignores a job whose ownership does not match the material',
    async () => {
      // The worker runs with the service role, which bypasses RLS entirely, so
      // the ONLY thing scoping it is the ownership carried in the payload. A
      // forged payload must find nothing rather than process someone's file.
      const { materialId } = await stageMaterial(makePdf(['Ownership check material.']));

      await expect(
        processMaterial({ materialId, userId: otherUserId, projectId }),
      ).resolves.toBeUndefined();

      // Untouched: still queued, never processed on the attacker's behalf.
      expect((await readMaterial(materialId)).status).toBe('queued');
      expect(await countChunks(materialId)).toBe(0);
    },
    JOB_TIMEOUT,
  );

  it(
    'skips silently when the material was deleted between enqueue and execution',
    async () => {
      const { materialId } = await stageMaterial(makePdf(['Doomed material.']));
      await serviceClient().from('materials').delete().eq('id', materialId);

      // Must not throw: retrying a job for a row that no longer exists would
      // burn the retry budget on work that can never succeed.
      await expect(processMaterial({ materialId, userId, projectId })).resolves.toBeUndefined();
    },
    JOB_TIMEOUT,
  );

  it(
    'refuses to call a partially embedded document ready',
    async () => {
      const { materialId } = await stageMaterial(
        makePdf(['Respiration releases energy from glucose in a series of enzyme-controlled steps.']),
      );
      await processMaterial({ materialId, userId, projectId });
      expect((await readMaterial(materialId)).status).toBe('ready');

      // Simulate the outdated-worker case: chunks present, embeddings missing.
      // A partially indexed document lets the Tutor answer from some pages and
      // silently ignore others, which is worse than not being ready.
      await serviceClient().from('material_chunks').update({ embedding: null }).eq('material_id', materialId);
      await serviceClient().from('materials').update({ status: 'queued' }).eq('id', materialId);

      // Re-running repairs it rather than leaving it broken.
      await processMaterial({ materialId, userId, projectId });
      const material = await readMaterial(materialId);
      expect(material.status).toBe('ready');

      const { count } = await serviceClient()
        .from('material_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('material_id', materialId)
        .is('embedding', null);
      expect(count).toBe(0);
    },
    JOB_TIMEOUT,
  );
});
