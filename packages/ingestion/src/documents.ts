import {
  chunks,
  documents,
  documentVersions,
  getPgError,
  ingestionJobs,
  PG_UNIQUE_VIOLATION,
  type Database,
  type DocumentRow,
  type DocumentVersionRow,
  type IngestionJobRow,
} from '@narada/database';
import { appErrors } from '@narada/shared';
import { assertIndexable, requireSource } from '@narada/source-registry';
import type { BlobStore } from '@narada/storage';
import { and, count, desc, eq, max } from 'drizzle-orm';
import { toDocumentDto, toJobDto, toVersionDto, type DocumentDto, type JobDto, type VersionDto } from './dto';
import { validateUpload, type UploadFile } from './upload';

export interface SubmitDeps {
  db: Database;
  blobs: BlobStore;
  maxUploadBytes: number;
}

export interface SubmitInput {
  sourceId: string;
  /** Declared title. When absent the filename stem is used and the title is marked as filename-derived. */
  title?: string | null;
  language?: string | null;
  /** Add a new version to this document instead of creating one. */
  documentId?: string | null;
  file: UploadFile;
}

export interface SubmitResult {
  document: DocumentDto;
  version: VersionDto;
  job: JobDto | null;
  /** True when identical content was already registered for this source: nothing new was created. */
  deduplicated: boolean;
}

function filenameStem(filename: string | null): string | null {
  const base = (filename ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem || null;
}

async function latestJobFor(db: Database, versionId: string): Promise<IngestionJobRow | null> {
  const [job] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.documentVersionId, versionId))
    .orderBy(desc(ingestionJobs.createdAt), desc(ingestionJobs.id))
    .limit(1);
  return job ?? null;
}

async function existingResult(db: Database, version: DocumentVersionRow): Promise<SubmitResult> {
  const [document] = await db.select().from(documents).where(eq(documents.id, version.documentId));
  if (!document) throw appErrors.internal(new Error(`version ${version.id} has no document`));
  const job = await latestJobFor(db, version.id);
  return {
    document: toDocumentDto(document),
    version: toVersionDto(version),
    job: job ? toJobDto(job) : null,
    deduplicated: true,
  };
}

/**
 * Registers an upload and queues its ingestion. Idempotent: identical bytes for the same source return the
 * existing document/version and create nothing. The original bytes are stored untouched and content-addressed
 * before any database row refers to them.
 */
export async function submitDocument(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  const { db, blobs } = deps;
  const source = await requireSource(db, input.sourceId);
  assertIndexable(source);

  const upload = validateUpload(input.file, { maxBytes: deps.maxUploadBytes });
  if (source.contentChecksum && source.contentChecksum !== upload.sha256) {
    throw appErrors.checksumMismatch(source.contentChecksum, upload.sha256);
  }

  const findExisting = async () => {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(and(eq(documentVersions.sourceId, source.id), eq(documentVersions.contentSha256, upload.sha256)))
      .limit(1);
    return version ?? null;
  };

  const duplicate = await findExisting();
  if (duplicate) return existingResult(db, duplicate);

  const title = input.title?.trim() || filenameStem(input.file.filename);
  if (!input.documentId && !title) {
    throw appErrors.validation('A title is required when the upload has no filename.');
  }

  const blob = await blobs.put(input.file.bytes);

  try {
    const created = await db.transaction(async (tx) => {
      let document: DocumentRow;
      if (input.documentId) {
        const [locked] = await tx.select().from(documents).where(eq(documents.id, input.documentId)).for('update');
        if (!locked) throw appErrors.documentNotFound(input.documentId);
        if (locked.sourceId !== source.id) {
          throw appErrors.validation('documentId belongs to a different source.', { documentId: input.documentId });
        }
        document = locked;
      } else {
        const [inserted] = await tx
          .insert(documents)
          .values({
            sourceId: source.id,
            title: title!,
            titleOrigin: input.title?.trim() ? 'declared' : 'filename',
            originalLanguage: input.language ?? source.originalLanguage,
          })
          .returning();
        document = inserted!;
      }

      const [{ latest } = { latest: null }] = await tx
        .select({ latest: max(documentVersions.versionNumber) })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, document.id));

      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId: document.id,
          sourceId: source.id,
          versionNumber: (latest ?? 0) + 1,
          contentSha256: upload.sha256,
          byteSize: upload.byteSize,
          mimeType: upload.mimeType,
          originalFilename: input.file.filename,
          storageKey: blob.key,
        })
        .returning();
      const [job] = await tx
        .insert(ingestionJobs)
        .values({ documentVersionId: version!.id, status: 'PENDING', queuedAt: new Date() })
        .returning();
      return { document, version: version!, job: job! };
    });

    return {
      document: toDocumentDto(created.document),
      version: toVersionDto(created.version),
      job: toJobDto(created.job),
      deduplicated: false,
    };
  } catch (error) {
    // Two concurrent uploads of the same bytes: the loser sees the winner's rows instead of failing.
    const pg = getPgError(error);
    if (pg?.code === PG_UNIQUE_VIOLATION && pg.constraint === 'document_versions_source_content_unique') {
      const winner = await findExisting();
      if (winner) return existingResult(db, winner);
    }
    throw error;
  }
}

export interface DocumentDetails {
  document: DocumentDto;
  latestVersion: VersionDto;
  latestJob: JobDto | null;
  chunkCount: number;
  versions: Array<{ id: string; versionNumber: number; createdAt: string }>;
}

export async function getDocumentDetails(db: Database, documentId: string): Promise<DocumentDetails> {
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!document) throw appErrors.documentNotFound(documentId);

  const versions = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNumber));
  const latest = versions[0];
  if (!latest) throw appErrors.internal(new Error(`document ${documentId} has no versions`));

  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(chunks)
    .where(eq(chunks.documentVersionId, latest.id));
  const job = await latestJobFor(db, latest.id);

  return {
    document: toDocumentDto(document),
    latestVersion: toVersionDto(latest),
    latestJob: job ? toJobDto(job) : null,
    chunkCount: n,
    versions: versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, createdAt: v.createdAt.toISOString() })),
  };
}

/** Queues a fresh job for the latest version when its last job FAILED. History is kept: failed jobs are never reused. */
export async function retryDocument(db: Database, documentId: string): Promise<JobDto> {
  const details = await getDocumentDetails(db, documentId);
  const last = details.latestJob;
  if (!last) throw appErrors.retryNotAllowed('The latest version has no ingestion job to retry.');
  if (last.status !== 'FAILED') {
    throw appErrors.retryNotAllowed(`Only failed ingestions can be retried; the latest job is ${last.status}.`);
  }
  try {
    const [job] = await db
      .insert(ingestionJobs)
      .values({
        documentVersionId: details.latestVersion.id,
        status: 'PENDING',
        retryOfJobId: last.id,
        queuedAt: new Date(),
      })
      .returning();
    return toJobDto(job!);
  } catch (error) {
    if (getPgError(error)?.constraint === 'ingestion_jobs_one_active_per_version') {
      throw appErrors.retryNotAllowed('An ingestion for this version is already queued or running.');
    }
    throw error;
  }
}
