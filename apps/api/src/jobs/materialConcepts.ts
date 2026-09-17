import { extractConcepts } from '../lib/concepts.ts';
import { serviceClient } from '../lib/supabase.ts';

export type MaterialConceptsJob = {
  materialId: string;
  userId: string;
  projectId: string;
  /** Re-extract even if this material already produced concepts. */
  force?: boolean;
};

/**
 * Extracts and persists the concepts a document teaches.
 *
 * A SEPARATE job from material.process, not a step inside it. Indexing and
 * concept extraction fail for different reasons — extraction depends on a
 * generation provider and its rate limits, indexing does not — and a document
 * that is fully indexed and searchable should not be marked `failed` because an
 * LLM call was rate-limited. The Tutor works either way; only quizzes need
 * concepts.
 *
 * Isolation: service role, so every query filters on the payload's userId and
 * projectId explicitly (PRD §15).
 *
 * Idempotency needs more than an upsert. Upserting on (project_id, name) stops
 * identical names duplicating, but the model does not name things identically
 * across runs: re-running on the same document produced 8 concepts and then 10,
 * overlapping only partly, growing the project to 14. Concepts accumulating on
 * every retry would corrupt mastery (evidence split across near-synonyms) and
 * quietly waste quota.
 *
 * So the job is a no-op when this material has already produced concepts,
 * unless explicitly forced. See D-036.
 */
export async function extractMaterialConcepts(job: MaterialConceptsJob): Promise<number> {
  const db = serviceClient();
  const { materialId, userId, projectId } = job;

  const { data: material } = await db
    .from('materials')
    .select('id, filename, status')
    .eq('id', materialId)
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .single();

  if (!material) {
    console.warn('[material.concepts] material not found, skipping', materialId);
    return 0;
  }
  if (material.status !== 'ready') {
    // Indexing failed or is still running; there is nothing meaningful to read.
    console.warn('[material.concepts] material not ready, skipping', materialId);
    return 0;
  }

  if (!job.force) {
    const { count } = await db
      .from('concepts')
      .select('id', { count: 'exact', head: true })
      .eq('source_material_id', materialId)
      .eq('user_id', userId);
    if ((count ?? 0) > 0) {
      console.log(`[material.concepts] ${materialId}: already has ${count} concepts, skipping`);
      return count ?? 0;
    }
  }

  const { data: project } = await db
    .from('projects')
    .select('name, goal')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();

  const { data: chunks, error } = await db
    .from('material_chunks')
    .select('chunk_index, page_number, content, token_count')
    .eq('material_id', materialId)
    .eq('user_id', userId)
    .order('chunk_index', { ascending: true });

  if (error) throw new Error(`Could not read chunks: ${error.message}`);
  if (!chunks || chunks.length === 0) return 0;

  const { concepts } = await extractConcepts({
    chunks: chunks.map((c) => ({
      chunkIndex: c.chunk_index as number,
      pageNumber: c.page_number as number,
      content: c.content as string,
      tokenCount: c.token_count as number,
    })),
    filename: material.filename as string,
    projectName: project?.name as string | undefined,
    goal: project?.goal as string | undefined,
    userId,
    projectId,
  });

  if (concepts.length === 0) return 0;

  // Upsert on (project_id, name): a second document covering the same concept
  // attaches to the existing row instead of creating a rival one, which keeps
  // one mastery score per concept rather than splitting it.
  const { error: writeError } = await db.from('concepts').upsert(
    concepts.map((c) => ({
      project_id: projectId,
      user_id: userId,
      name: c.name,
      description: c.description,
      source_material_id: materialId,
    })),
    { onConflict: 'project_id,name' },
  );

  if (writeError) throw new Error(`Concept write failed: ${writeError.message}`);

  console.log(`[material.concepts] ${materialId}: ${concepts.length} concepts`);
  return concepts.length;
}
