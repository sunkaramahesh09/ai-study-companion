import { uuidParamSchema } from '@asc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseOrReply, replyDbError } from '../lib/errors.ts';
import { recordEvent } from '../lib/events.ts';
import { enqueueMaterialProcess } from '../lib/queue.ts';
import { serviceClient } from '../lib/supabase.ts';

const MAX_BYTES = 25 * 1024 * 1024;
const BUCKET = 'materials';

const SELECT =
  'id, project_id, filename, status, page_count, chunk_count, size_bytes, error_message, processed_at, created_at';

/** PDFs begin with %PDF-. Content-Type is client-supplied and trivially spoofed. */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length > 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

export const materialRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Upload a PDF.
   *
   * The file is proxied through the API rather than uploaded straight to
   * Storage with a signed URL (D-026). One round trip, one place that
   * validates the bytes, creates the tracking row and enqueues the job — so a
   * client cannot leave an orphaned object or a row pointing at a non-PDF.
   */
  app.post('/api/materials', { preHandler: app.requireAuth }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    if (!file) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Expected a file upload.' });
    }

    const projectId = (file.fields as Record<string, { value?: string } | undefined>)?.projectId?.value;
    const parsedProject = z.string().uuid().safeParse(projectId);
    if (!parsedProject.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'projectId must be a UUID.' });
    }

    // Ownership check through the RLS-scoped client: if the project is not the
    // caller's, this returns nothing and we stop before touching Storage.
    const { data: project, error: projectError } = await req
      .db!.from('projects')
      .select('id')
      .eq('id', parsedProject.data)
      .single();
    if (projectError || !project) {
      return reply.code(404).send({ error: 'not_found', message: 'Project not found.' });
    }

    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({ error: 'too_large', message: 'The file exceeds 25 MB.' });
    }
    if (!looksLikePdf(bytes)) {
      // Checked by magic bytes, not by the declared Content-Type.
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'Only PDF files are supported.' });
    }

    const materialId = crypto.randomUUID();
    // user_id first so the storage policy in 0007 can enforce ownership on the
    // path itself.
    const storagePath = `${req.user!.id}/${parsedProject.data}/${materialId}.pdf`;

    const upload = await serviceClient()
      .storage.from(BUCKET)
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });

    if (upload.error) {
      req.log.error({ err: upload.error }, 'storage upload failed');
      return reply.code(502).send({ error: 'upload_failed', message: 'Could not store the file.' });
    }

    const { data: material, error } = await req
      .db!.from('materials')
      .insert({
        id: materialId,
        project_id: parsedProject.data,
        user_id: req.user!.id,
        filename: file.filename.slice(0, 200),
        storage_path: storagePath,
        size_bytes: bytes.length,
        status: 'queued',
      })
      .select(SELECT)
      .single();

    if (error) {
      // Do not leave an orphaned object behind if the row could not be written.
      await serviceClient().storage.from(BUCKET).remove([storagePath]);
      return replyDbError(reply, error);
    }

    await recordEvent({
      userId: req.user!.id,
      type: 'material_uploaded',
      projectId: parsedProject.data,
      payload: { materialId, filename: material.filename, sizeBytes: bytes.length },
      idempotencyKey: `material_uploaded:${materialId}`,
    });

    try {
      await enqueueMaterialProcess({
        materialId,
        userId: req.user!.id,
        projectId: parsedProject.data,
      });
    } catch (err) {
      // The row stays 'queued' and is recoverable by re-triggering, rather than
      // failing the user's upload after the bytes are safely stored.
      req.log.error({ err }, 'failed to enqueue material.process');
    }

    return reply.code(201).send({ material });
  });

  app.get('/api/materials', { preHandler: app.requireAuth }, async (req, reply) => {
    const query = z.object({ projectId: z.string().uuid() }).safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'projectId is required.' });
    }

    const { data, error } = await req
      .db!.from('materials')
      .select(SELECT)
      .eq('project_id', query.data.projectId)
      .order('created_at', { ascending: false });

    if (error) return replyDbError(reply, error);
    return { materials: data };
  });

  app.get('/api/materials/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data, error } = await req.db!.from('materials').select(SELECT).eq('id', params.id).single();
    if (error) return replyDbError(reply, error);
    return { material: data };
  });

  /**
   * Re-queue a failed document. Safe to call repeatedly: the job's singletonKey
   * is the materialId, and chunk writes are upserts keyed on
   * (material_id, chunk_index).
   */
  app.post('/api/materials/:id/retry', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data: material, error } = await req
      .db!.from('materials')
      .select('id, project_id, status')
      .eq('id', params.id)
      .single();
    if (error) return replyDbError(reply, error);

    if (material.status === 'processing') {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'That document is already being processed.' });
    }

    await serviceClient()
      .from('materials')
      .update({ status: 'queued', error_message: null })
      .eq('id', params.id)
      .eq('user_id', req.user!.id);

    await enqueueMaterialProcess({
      materialId: params.id,
      userId: req.user!.id,
      projectId: material.project_id,
    });

    return { ok: true, status: 'queued' };
  });

  app.delete('/api/materials/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const params = parseOrReply(uuidParamSchema, req.params, reply);
    if (!params) return;

    const { data, error } = await req
      .db!.from('materials')
      .delete()
      .eq('id', params.id)
      .select('id, storage_path');

    if (error) return replyDbError(reply, error);
    if (!data || data.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }

    // Chunks cascade via the FK; the stored object does not, so remove it here.
    await serviceClient().storage.from(BUCKET).remove([data[0]!.storage_path]);
    return reply.code(204).send();
  });
};
