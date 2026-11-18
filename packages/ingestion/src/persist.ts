import { chunks, type Database } from '@narada/database';
import { asc, eq } from 'drizzle-orm';
import type { ChunkDraft } from './chunking/chunker';

type Executor = Pick<Database, 'select' | 'insert' | 'delete'>;

const INSERT_BATCH = 200;

/**
 * Makes the stored chunks of a version equal to `drafts`, inside the caller's transaction.
 * Chunk ids are deterministic (version + config + position + content), so when an identical set is already
 * stored, e.g. a retry of a job that had in fact finished chunking, nothing is rewritten. That keeps
 * retries free of duplicates and preserves anything later attached to those rows (embeddings).
 */
export async function replaceChunks(
  executor: Executor,
  documentVersionId: string,
  drafts: ChunkDraft[],
): Promise<{ changed: boolean; count: number }> {
  const existing = await executor
    .select({ id: chunks.id })
    .from(chunks)
    .where(eq(chunks.documentVersionId, documentVersionId))
    .orderBy(asc(chunks.chunkIndex));

  if (existing.length === drafts.length && existing.every((row, i) => row.id === drafts[i]!.id)) {
    return { changed: false, count: drafts.length };
  }

  await executor.delete(chunks).where(eq(chunks.documentVersionId, documentVersionId));
  for (let i = 0; i < drafts.length; i += INSERT_BATCH) {
    await executor.insert(chunks).values(
      drafts.slice(i, i + INSERT_BATCH).map((draft) => ({
        id: draft.id,
        documentVersionId: draft.documentVersionId,
        documentId: draft.documentId,
        sourceId: draft.sourceId,
        chunkIndex: draft.chunkIndex,
        content: draft.content,
        contentSha256: draft.contentSha256,
        tokenEstimate: draft.tokenEstimate,
        pageStart: draft.pageStart,
        pageEnd: draft.pageEnd,
        headingPath: draft.headingPath,
        sectionId: draft.sectionId,
        charStart: draft.charStart,
        charEnd: draft.charEnd,
        offsetBasis: draft.offsetBasis,
        locator: draft.locator,
        extractionMethod: draft.extractionMethod,
        chunkerVersion: draft.chunkerVersion,
        chunkingConfigHash: draft.chunkingConfigHash,
      })),
    );
  }
  return { changed: true, count: drafts.length };
}
