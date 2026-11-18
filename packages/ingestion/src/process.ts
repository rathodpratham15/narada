import {
  describeDatabaseError,
  documents,
  documentVersions,
  ingestionJobs,
  chunks,
  type Database,
  type IngestionJobRow,
} from '@narada/database';
import { sha256Hex } from '@narada/shared';
import { BlobCorruptedError, BlobNotFoundError, type BlobStore } from '@narada/storage';
import { and, eq, sql } from 'drizzle-orm';
import { chunkDocument, type ChunkDraft } from './chunking/chunker';
import { DEFAULT_CHUNKING_CONFIG, describeChunking, type ChunkingConfig } from './chunking/config';
import { approxTokenCounter, type TokenCounter } from './chunking/tokens';
import { extractorFor, formatFromMime } from './extractors/registry';
import { DEFAULT_EXTRACTION_LIMITS, type ExtractionLimits, type ExtractionResult } from './model';
import { replaceChunks } from './persist';

export const JOB_ERROR_CODES = [
  'BLOB_MISSING',
  'BLOB_INTEGRITY_ERROR',
  'UNSUPPORTED_FORMAT',
  'NO_CHUNKS',
  'CHUNKING_FAILED',
  'CHUNK_PERSISTENCE_FAILED',
  'WORKER_LOST',
  'INTERNAL_ERROR',
] as const;

export type Stage = 'extract' | 'chunk' | 'store';

interface LoggerLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProcessDeps {
  db: Database;
  blobs: BlobStore;
  logger?: LoggerLike;
  limits?: ExtractionLimits;
  chunking?: ChunkingConfig;
  counter?: TokenCounter;
  /** How often the job proves it is alive. Stale jobs are recovered by `recoverStaleJobs`. */
  heartbeatMs?: number;
  /** Replaceable for tests that need to provoke chunking or persistence failures. */
  chunk?: typeof chunkDocument;
}

export type ProcessOutcome =
  | { status: 'COMPLETED'; chunkCount: number; warnings: number }
  | { status: 'FAILED'; errorCode: string }
  | { status: 'SKIPPED'; reason: string };

class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage: Stage,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Raised when the job row is no longer PROCESSING (e.g. recovered as stale and re-queued elsewhere). */
class JobLost extends Error {}

/**
 * Atomically takes the oldest PENDING job. `FOR UPDATE SKIP LOCKED` lets any number of workers poll
 * concurrently without ever claiming the same job twice.
 */
export async function claimNextJob(db: Database): Promise<IngestionJobRow | null> {
  const result = await db.execute<{ id: string }>(sql`
    update ingestion_jobs
       set status = 'PROCESSING', stage = 'extract', attempt = attempt + 1,
           started_at = now(), heartbeat_at = now(), updated_at = now(),
           error_code = null, error_message = null, error_details = null
     where id = (
       select id from ingestion_jobs
        where status = 'PENDING'
        order by created_at, id
        for update skip locked
        limit 1)
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id));
  return job ?? null;
}

/**
 * Recovers jobs whose worker died mid-run: PROCESSING with a stale heartbeat goes back to PENDING, or to FAILED
 * (WORKER_LOST) once it has used all attempts.
 */
export async function recoverStaleJobs(
  db: Database,
  options: { staleAfterMs: number; maxAttempts: number },
): Promise<{ requeued: number; failed: number }> {
  const seconds = options.staleAfterMs / 1000;
  const failed = await db.execute(sql`
    update ingestion_jobs
       set status = 'FAILED', error_code = 'WORKER_LOST', finished_at = now(), updated_at = now(),
           error_message = 'The worker processing this job stopped responding and the attempt limit was reached.'
     where status = 'PROCESSING' and heartbeat_at < now() - make_interval(secs => ${seconds})
       and attempt >= ${options.maxAttempts}`);
  const requeued = await db.execute(sql`
    update ingestion_jobs
       set status = 'PENDING', stage = null, started_at = null, heartbeat_at = null, updated_at = now()
     where status = 'PROCESSING' and heartbeat_at < now() - make_interval(secs => ${seconds})
       and attempt < ${options.maxAttempts}`);
  return { requeued: requeued.rowCount ?? 0, failed: failed.rowCount ?? 0 };
}

async function touch(db: Database, jobId: string, stage: Stage): Promise<void> {
  const updated = await db
    .update(ingestionJobs)
    .set({ stage, heartbeatAt: new Date() })
    .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.status, 'PROCESSING')))
    .returning({ id: ingestionJobs.id });
  if (updated.length === 0) throw new JobLost();
}

async function markFailed(db: Database, jobId: string, failure: JobFailure): Promise<boolean> {
  const updated = await db
    .update(ingestionJobs)
    .set({
      status: 'FAILED',
      stage: failure.stage,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 2000),
      errorDetails: failure.details ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.status, 'PROCESSING')))
    .returning({ id: ingestionJobs.id });
  return updated.length > 0;
}

/**
 * Runs one claimed job: read the original → extract → chunk → store. COMPLETED is written in the same transaction
 * as the chunks, so a job is never reported complete unless its chunks were actually persisted. Every failure is
 * recorded on the job with a code, message and details; nothing is swallowed.
 */
export async function processJob(deps: ProcessDeps, jobId: string): Promise<ProcessOutcome> {
  const { db, blobs, logger } = deps;
  const limits = deps.limits ?? DEFAULT_EXTRACTION_LIMITS;
  const chunking = deps.chunking ?? DEFAULT_CHUNKING_CONFIG;
  const counter = deps.counter ?? approxTokenCounter;
  const chunk = deps.chunk ?? chunkDocument;

  const [row] = await db
    .select({ job: ingestionJobs, version: documentVersions, document: documents })
    .from(ingestionJobs)
    .innerJoin(documentVersions, eq(documentVersions.id, ingestionJobs.documentVersionId))
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(ingestionJobs.id, jobId));
  if (!row) return { status: 'SKIPPED', reason: 'job not found' };
  if (row.job.status !== 'PROCESSING') return { status: 'SKIPPED', reason: `job is ${row.job.status}, not PROCESSING` };
  const { version, document } = row;

  const heartbeat = setInterval(() => {
    void touch(db, jobId, (row.job.stage as Stage | null) ?? 'extract').catch(() => undefined);
  }, deps.heartbeatMs ?? 15_000);
  heartbeat.unref();

  let stage: Stage = 'extract';
  try {
    // ---- extract ----------------------------------------------------------------------------
    let bytes: Uint8Array;
    try {
      bytes = await blobs.get(version.storageKey);
    } catch (error) {
      if (error instanceof BlobNotFoundError) throw new JobFailure('BLOB_MISSING', error.message, stage);
      if (error instanceof BlobCorruptedError) throw new JobFailure('BLOB_INTEGRITY_ERROR', error.message, stage);
      throw error;
    }
    if (sha256Hex(bytes) !== version.contentSha256) {
      throw new JobFailure('BLOB_INTEGRITY_ERROR', 'Stored bytes do not match the version checksum.', stage, {
        expected: version.contentSha256,
      });
    }
    const format = formatFromMime(version.mimeType);
    if (!format) throw new JobFailure('UNSUPPORTED_FORMAT', `No extractor for ${version.mimeType}.`, stage);

    const extractor = extractorFor(format);
    let result: ExtractionResult;
    try {
      result = await extractor.extract({ bytes, filename: version.originalFilename }, limits);
    } catch (error) {
      throw new JobFailure('INTERNAL_ERROR', `Extractor crashed: ${(error as Error).message}`, stage);
    }

    if (!result.ok) {
      await db
        .update(documentVersions)
        .set({
          extractionMeta: {
            method: extractor.extractionMethod,
            status: 'failed',
            warnings: result.warnings,
            error: result.error,
          },
        })
        .where(eq(documentVersions.id, version.id));
      throw new JobFailure(result.error.code, result.error.message, stage, result.error.details);
    }
    const extracted = result.document;

    // ---- chunk ------------------------------------------------------------------------------
    stage = 'chunk';
    await touch(db, jobId, stage);
    let drafts: ChunkDraft[];
    try {
      drafts = chunk(
        extracted,
        { sourceId: version.sourceId, documentId: version.documentId, documentVersionId: version.id },
        chunking,
        counter,
      );
    } catch (error) {
      throw new JobFailure('CHUNKING_FAILED', `Chunking failed: ${(error as Error).message}`, stage);
    }
    if (drafts.length === 0) {
      throw new JobFailure('NO_CHUNKS', 'The document produced no chunks (it has headings but no body text).', stage);
    }

    // ---- store ------------------------------------------------------------------------------
    stage = 'store';
    await touch(db, jobId, stage);
    const pageSummary =
      extracted.pages.length > 0
        ? {
            total: extracted.pages.length,
            text: extracted.pages.filter((p) => p.kind === 'text').length,
            blank: extracted.pages.filter((p) => p.kind === 'blank').map((p) => p.page),
            imageOnly: extracted.pages.filter((p) => p.kind === 'image_only').map((p) => p.page),
          }
        : null;

    let stored: { count: number };
    try {
      stored = await db.transaction(async (tx) => {
        const outcome = await replaceChunks(tx, version.id, drafts);
        await tx
          .update(documentVersions)
          .set({
            pageCount: extracted.metadata.pageCount,
            extractedTitle: extracted.metadata.title,
            extractionMeta: {
              method: extracted.extractionMethod,
              status: 'ok',
              warnings: extracted.warnings,
              pages: pageSummary,
              offsetBasis: extracted.offsetBasis,
              encoding: extracted.metadata.encoding,
              author: extracted.metadata.author,
            },
            chunkingConfig: describeChunking(chunking, counter),
          })
          .where(eq(documentVersions.id, version.id));
        if (document.titleOrigin === 'filename' && extracted.metadata.title) {
          await tx
            .update(documents)
            .set({ title: extracted.metadata.title, titleOrigin: 'extracted' })
            .where(eq(documents.id, document.id));
        }
        const done = await tx
          .update(ingestionJobs)
          .set({ status: 'COMPLETED', stage: 'store', finishedAt: new Date(), heartbeatAt: new Date() })
          .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.status, 'PROCESSING')))
          .returning({ id: ingestionJobs.id });
        if (done.length === 0) throw new JobLost(); // rolls back the chunks too
        return outcome;
      });
    } catch (error) {
      if (error instanceof JobLost) throw error;
      throw new JobFailure('CHUNK_PERSISTENCE_FAILED', `Chunks could not be stored: ${describeDatabaseError(error)}`, stage);
    }

    logger?.info({ jobId, documentId: document.id, chunks: stored.count, warnings: extracted.warnings.length }, 'ingestion completed');
    return { status: 'COMPLETED', chunkCount: stored.count, warnings: extracted.warnings.length };
  } catch (error) {
    if (error instanceof JobLost) {
      logger?.warn({ jobId }, 'job was taken over or cancelled while processing; discarding result');
      return { status: 'SKIPPED', reason: 'job no longer owned by this worker' };
    }
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('INTERNAL_ERROR', `Unexpected error: ${describeDatabaseError(error) === 'database error' ? (error as Error).message.slice(0, 300) : describeDatabaseError(error)}`, stage);
    if (failure.code === 'INTERNAL_ERROR') logger?.error({ jobId, err: error }, 'unexpected ingestion error');
    else logger?.warn({ jobId, code: failure.code }, 'ingestion failed');
    await markFailed(db, jobId, failure);
    return { status: 'FAILED', errorCode: failure.code };
  } finally {
    clearInterval(heartbeat);
  }
}

export async function countChunks(db: Database, documentVersionId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.documentVersionId, documentVersionId));
  return n;
}
