import type { SupabaseClient } from '@supabase/supabase-js';
import { embeddingProvider } from './ai.ts';

export type RetrievedChunk = {
  id: string;
  materialId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  /** Cosine distance. 0 = identical; smaller is more similar. */
  distance: number;
};

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  /** Best (smallest) distance, or null when nothing matched. */
  bestDistance: number | null;
  /** Total chunks in the project and how many are searchable. */
  indexed: { total: number; embedded: number; readyMaterials: number };
  /**
   * Why retrieval produced nothing useful. The Tutor answers very differently
   * for "you haven't uploaded anything" than for "your material doesn't cover
   * this" — collapsing them into one message is what makes a RAG app feel
   * broken (PRD §7).
   */
  reason: 'ok' | 'no_materials' | 'not_indexed' | 'no_relevant_evidence';
};

/**
 * Cosine-distance ceiling for a chunk to count as evidence.
 *
 * Only meaningful because vectors are unit-normalized in the embedding provider
 * (D-017). With unnormalized vectors this threshold would mean something
 * different for every chunk, and the evidence gate would be nonsense.
 *
 * MEASURED against the indexed 25-chunk PRD (see D-029 for the full table):
 *
 *   on-topic   0.247  0.266  0.271  0.336      worst 0.336
 *   off-topic  0.515  0.522  0.561              best  0.515
 *
 * 0.45 sits in the gap: 0.11 of headroom above the worst genuine question and
 * 0.065 below the closest unrelated one.
 *
 * The margin is narrower than it looks comfortable being — embeddings of
 * natural-language questions are never wildly far apart, and a small corpus
 * compresses the range further. So this gate is NOT the only defence against
 * fabrication: task 11 also instructs the model to refuse when the supplied
 * evidence does not answer the question. Two independent mechanisms, because
 * one empirical constant should not be all that stands between the product and
 * a confident wrong answer. The evaluation suite (task 22) re-measures this so
 * a change to the embedding model or chunking cannot silently move it.
 */
export const RELEVANCE_THRESHOLD = 0.45;

export type RetrieveOptions = {
  matchCount?: number;
  maxDistance?: number;
  /** Token ceiling for the assembled context. Groq's 8000 TPM is the binding constraint. */
  maxContextTokens?: number;
};

/**
 * Project-scoped retrieval.
 *
 * `db` should be the caller's RLS-scoped client for user requests, so Postgres
 * filters to their own chunks regardless of the project id passed in. The
 * worker passes a service-role client and relies on the explicit project
 * filter.
 */
export async function retrieve(
  db: SupabaseClient,
  projectId: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const matchCount = options.matchCount ?? 8;
  const maxDistance = options.maxDistance ?? RELEVANCE_THRESHOLD;

  const { data: statsRows } = await db.rpc('project_index_stats', { p_project_id: projectId });
  const stats = (statsRows as { total_chunks: number; embedded_chunks: number; ready_materials: number }[] | null)?.[0];
  const indexed = {
    total: Number(stats?.total_chunks ?? 0),
    embedded: Number(stats?.embedded_chunks ?? 0),
    readyMaterials: Number(stats?.ready_materials ?? 0),
  };

  // Distinguish the two empty cases before spending an embedding call.
  if (indexed.total === 0) {
    return { chunks: [], bestDistance: null, indexed, reason: 'no_materials' };
  }
  if (indexed.embedded === 0) {
    return { chunks: [], bestDistance: null, indexed, reason: 'not_indexed' };
  }

  // RETRIEVAL_QUERY, matching the RETRIEVAL_DOCUMENT side used at index time.
  const provider = embeddingProvider();
  const { vectors } = await provider.embed({
    texts: [query],
    taskType: 'RETRIEVAL_QUERY',
    projectId,
  });
  const queryVector = vectors[0];
  if (!queryVector) {
    return { chunks: [], bestDistance: null, indexed, reason: 'no_relevant_evidence' };
  }

  const { data, error } = await db.rpc('match_material_chunks', {
    p_project_id: projectId,
    p_query_embedding: JSON.stringify(queryVector),
    p_match_count: matchCount,
    p_max_distance: maxDistance,
  });

  if (error) throw new Error(`Retrieval failed: ${error.message}`);

  const rows = (data ?? []) as {
    id: string;
    material_id: string;
    filename: string;
    page_number: number;
    chunk_index: number;
    content: string;
    distance: number;
  }[];

  const chunks: RetrievedChunk[] = rows.map((r) => ({
    id: r.id,
    materialId: r.material_id,
    filename: r.filename,
    pageNumber: r.page_number,
    chunkIndex: r.chunk_index,
    content: r.content,
    distance: Number(r.distance),
  }));

  if (chunks.length === 0) {
    return { chunks: [], bestDistance: null, indexed, reason: 'no_relevant_evidence' };
  }

  return {
    chunks: capContext(chunks, options.maxContextTokens ?? 2200),
    bestDistance: chunks[0]!.distance,
    indexed,
    reason: 'ok',
  };
}

/**
 * Trims the retrieved set to a token budget, best-first.
 *
 * Groq's 8000 TPM binds long before its 30 RPM (CLAUDE.md), and reasoning
 * tokens are billed on top (D-016). Sending every retrieved chunk would let a
 * single Tutor answer consume a quarter of the minute's budget, so the least
 * relevant chunks are dropped rather than the prompt being allowed to grow.
 */
function capContext(chunks: RetrievedChunk[], maxTokens: number): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const cost = Math.ceil(c.content.length / 4);
    // Always keep the single best chunk, even if it alone exceeds the budget —
    // returning nothing would look like "no evidence" when evidence exists.
    if (out.length > 0 && used + cost > maxTokens) break;
    out.push(c);
    used += cost;
  }
  return out;
}
