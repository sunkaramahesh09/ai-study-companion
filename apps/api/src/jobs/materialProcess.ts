import type { MaterialProcessJob } from '../lib/queue.ts';
import { chunkPages, extractPdf, type Chunk } from '../lib/pdf.ts';
import { recordEvent } from '../lib/events.ts';
import { serviceClient } from '../lib/supabase.ts';
import { embeddingProvider } from '../lib/ai.ts';

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
 * Embedding is resumable. A document is only 'ready' once every chunk has a
 * vector, because a partially embedded document would let the Tutor answer from
 * some pages while silently ignoring others — worse than not being ready at
 * all. On a retry, chunks whose text is unchanged and already have an embedding
 * are skipped, so a failure at chunk 280 of 300 does not re-spend 280 requests
 * against Gemini's ~1000/day ceiling.
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

    const embedded = await embedChunks(job, chunks);

    // A document is only 'ready' when every chunk is searchable. A partially
    // embedded document would let the Tutor answer from some pages while
    // silently ignoring others, and the user would have no way to tell — worse
    // than a document that is plainly not ready yet.
    //
    // This also catches the case where an outdated worker processed the job and
    // wrote chunks without embeddings at all.
    if (embedded < chunks.length) {
      throw new Error(
        `Only ${embedded} of ${chunks.length} chunks could be embedded. ` +
          `The document is not fully searchable; retry to finish indexing.`,
      );
    }

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
        embedded,
        emptyPages: extracted.emptyPages.length,
      },
      idempotencyKey: `material_ready:${materialId}`,
    });

    console.log(
      `[material.process] ready ${materialId}: ${extracted.pageCount} pages, ` +
        `${chunks.length} chunks, ${embedded} embedded`,
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

/**
 * Embeds every chunk that still needs it and writes the vectors back.
 *
 * Skipping already-embedded chunks whose text is unchanged is the whole point:
 * Gemini's free tier allows ~1000 requests a day, so a retry that re-embedded
 * everything from scratch could cost more quota than the original run.
 *
 * Returns how many chunks now carry a vector.
 */
async function embedChunks(job: MaterialProcessJob, chunks: Chunk[]): Promise<number> {
  const db = serviceClient();
  const { materialId, userId, projectId } = job;

  const { data: existing, error } = await db
    .from('material_chunks')
    .select('id, chunk_index, content, embedding')
    .eq('material_id', materialId)
    .eq('user_id', userId);

  if (error) throw new Error(`Could not read chunks for embedding: ${error.message}`);

  const byIndex = new Map(
    (existing ?? []).map((row) => [
      row.chunk_index as number,
      { id: row.id as string, content: row.content as string, hasEmbedding: row.embedding !== null },
    ]),
  );

  const pending = chunks.filter((c) => {
    const row = byIndex.get(c.chunkIndex);
    // Re-embed when the row is missing, has no vector, or its text changed.
    return !row || !row.hasEmbedding || row.content !== c.content;
  });

  if (pending.length === 0) {
    // Count what is actually embedded, not how many chunks exist. Returning
    // byIndex.size here would report a fully-indexed document when nothing had
    // been embedded at all.
    return countEmbedded(materialId);
  }

  const provider = embeddingProvider();
  // RETRIEVAL_DOCUMENT here; the Tutor's query side uses RETRIEVAL_QUERY.
  // Gemini embeds the two asymmetrically and mismatching them degrades recall.
  const result = await provider.embed({
    texts: pending.map((c) => c.content),
    taskType: 'RETRIEVAL_DOCUMENT',
    userId,
    projectId,
  });

  if (result.vectors.length !== pending.length) {
    throw new Error(
      `Embedding returned ${result.vectors.length} vectors for ${pending.length} chunks.`,
    );
  }

  // Write in batches so partial progress survives a mid-run failure: a later
  // retry then only has to embed what is still missing.
  for (let i = 0; i < pending.length; i += 100) {
    const slice = pending.slice(i, i + 100);
    const vectors = result.vectors.slice(i, i + 100);
    const rows = slice.map((c, n) => ({
      material_id: materialId,
      project_id: projectId,
      user_id: userId,
      page_number: c.pageNumber,
      chunk_index: c.chunkIndex,
      content: c.content,
      token_count: c.tokenCount,
      // pgvector accepts the JSON array form over PostgREST.
      embedding: JSON.stringify(vectors[n]),
    }));

    const { error: writeError } = await db
      .from('material_chunks')
      .upsert(rows, { onConflict: 'material_id,chunk_index' });
    if (writeError) throw new Error(`Embedding write failed: ${writeError.message}`);
  }

  return countEmbedded(materialId);
}

async function countEmbedded(materialId: string): Promise<number> {
  const { count } = await serviceClient()
    .from('material_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('material_id', materialId)
    .not('embedding', 'is', null);
  return count ?? 0;
}
