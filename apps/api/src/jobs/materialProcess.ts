import type { MaterialProcessJob } from '../lib/queue.ts';
import { chunkPages, extractPdf } from '../lib/pdf.ts';
import { recordEvent } from '../lib/events.ts';
import { serviceClient } from '../lib/supabase.ts';

const BUCKET = 'materials';

/**
 * Document processing: download → extract per page → chunk → mark ready.
 *
 * Isolation: this runs with the service role, which bypasses RLS entirely, so
 * every query filters on the job payload's `userId` and `projectId` explicitly.
 * That is why ownership travels with the job (PRD §15).
 *
 * Idempotency: the handler may run more than once — pg-boss retries, and a
 * worker can be killed mid-write. Two mechanisms make a re-run safe:
 *   1. chunks are upserted on (material_id, chunk_index), the unique key from
 *      migration 0002, so a repeat overwrites rather than duplicates;
 *   2. chunks beyond the new count are deleted, so a re-run over a document
 *      that now yields fewer chunks cannot leave stale ones behind.
 *
 * Embeddings are added in task 9. Until then chunks land with a null embedding
 * and the material is still marked ready, because the text itself is
 * searchable-in-principle and the status lifecycle is what task 8 delivers.
 */
export async function processMaterial(job: MaterialProcessJob): Promise<void> {
  const db = serviceClient();
  const { materialId, userId, projectId } = job;

  // Scoped by BOTH ids from the payload, never by materialId alone.
  const { data: material, error } = await db
    .from('materials')
    .select('id, storage_path, filename, status')
    .eq('id', materialId)
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .single();

  if (error || !material) {
    // Deleted between enqueue and execution. Nothing to do, and failing the job
    // would retry pointlessly.
    console.warn('[material.process] material not found, skipping', materialId);
    return;
  }

  // Already finished by an earlier attempt whose completion we did not observe.
  if (material.status === 'ready') {
    console.log('[material.process] already ready, skipping', materialId);
    return;
  }

  await db
    .from('materials')
    .update({ status: 'processing', processing_started_at: new Date().toISOString(), error_message: null })
    .eq('id', materialId)
    .eq('user_id', userId);

  await recordEvent({
    userId,
    projectId,
    type: 'material_processing',
    payload: { materialId },
    idempotencyKey: `material_processing:${materialId}`,
  });

  try {
    const download = await db.storage.from(BUCKET).download(material.storage_path);
    if (download.error || !download.data) {
      throw new Error(`Could not download the stored file: ${download.error?.message ?? 'no data'}`);
    }

    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const extracted = await extractPdf(bytes);
    const chunks = chunkPages(extracted.pages);

    if (chunks.length === 0) {
      // Almost always a scanned PDF with no text layer. There is no OCR
      // (D-027), so say so plainly instead of leaving an empty document the
      // Tutor believes is searchable.
      throw new Error(
        extracted.emptyPages.length === extracted.pageCount
          ? 'No text could be extracted. This looks like a scanned document, and image-only PDFs are not supported.'
          : 'No usable text could be extracted from this document.',
      );
    }

    // Upsert rather than insert: a retry overwrites the same (material, index)
    // pairs instead of duplicating them.
    const rows = chunks.map((c) => ({
      material_id: materialId,
      project_id: projectId,
      user_id: userId,
      page_number: c.pageNumber,
      chunk_index: c.chunkIndex,
      content: c.content,
      token_count: c.tokenCount,
    }));

    // Batched so one enormous document does not exceed the request size limit.
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const { error: upsertError } = await db
        .from('material_chunks')
        .upsert(batch, { onConflict: 'material_id,chunk_index' });
      if (upsertError) throw new Error(`Chunk write failed: ${upsertError.message}`);
    }

    // Remove any chunks left over from a previous, longer run.
    await db
      .from('material_chunks')
      .delete()
      .eq('material_id', materialId)
      .gte('chunk_index', chunks.length);

    await db
      .from('materials')
      .update({
        status: 'ready',
        page_count: extracted.pageCount,
        chunk_count: chunks.length,
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', materialId)
      .eq('user_id', userId);

    await recordEvent({
      userId,
      projectId,
      type: 'material_ready',
      payload: {
        materialId,
        pageCount: extracted.pageCount,
        chunkCount: chunks.length,
        emptyPages: extracted.emptyPages.length,
      },
      idempotencyKey: `material_ready:${materialId}`,
    });

    console.log(
      `[material.process] ready ${materialId}: ${extracted.pageCount} pages, ${chunks.length} chunks`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown processing error.';

    await db
      .from('materials')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', materialId)
      .eq('user_id', userId);

    await recordEvent({
      userId,
      projectId,
      type: 'material_failed',
      payload: { materialId, error: message.slice(0, 200) },
    });

    // Rethrow so pg-boss records the failure and applies its retry policy. The
    // status above is what the user sees in the meantime.
    throw err;
  }
}
