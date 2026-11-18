import type { DocumentRow, DocumentVersionRow, IngestionJobRow } from '@narada/database';
import type { ExtractionWarning } from './model';

export interface DocumentDto {
  id: string;
  sourceId: string;
  title: string;
  titleOrigin: string;
  originalLanguage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionSummaryDto {
  method: string | null;
  status: 'ok' | 'failed';
  warnings: ExtractionWarning[];
  pages: { total: number; text: number; blank: number[]; imageOnly: number[] } | null;
}

export interface VersionDto {
  id: string;
  versionNumber: number;
  contentSha256: string;
  byteSize: number;
  mimeType: string;
  originalFilename: string | null;
  pageCount: number | null;
  extractedTitle: string | null;
  detectedLanguage: string | null;
  extraction: ExtractionSummaryDto | null;
  chunking: Record<string, unknown> | null;
  createdAt: string;
}

export interface JobDto {
  id: string;
  documentVersionId: string;
  status: IngestionJobRow['status'];
  stage: string | null;
  attempt: number;
  retryOfJobId: string | null;
  error: { code: string; message: string; details: Record<string, unknown> | null } | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export const toDocumentDto = (row: DocumentRow): DocumentDto => ({
  id: row.id,
  sourceId: row.sourceId,
  title: row.title,
  titleOrigin: row.titleOrigin,
  originalLanguage: row.originalLanguage,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toVersionDto = (row: DocumentVersionRow): VersionDto => ({
  id: row.id,
  versionNumber: row.versionNumber,
  contentSha256: row.contentSha256,
  byteSize: row.byteSize,
  mimeType: row.mimeType,
  originalFilename: row.originalFilename,
  pageCount: row.pageCount,
  extractedTitle: row.extractedTitle,
  detectedLanguage: row.detectedLanguage,
  extraction: (row.extractionMeta as ExtractionSummaryDto | null) ?? null,
  chunking: row.chunkingConfig ?? null,
  createdAt: row.createdAt.toISOString(),
});

export const toJobDto = (row: IngestionJobRow): JobDto => ({
  id: row.id,
  documentVersionId: row.documentVersionId,
  status: row.status,
  stage: row.stage,
  attempt: row.attempt,
  retryOfJobId: row.retryOfJobId,
  error:
    row.errorCode && row.errorMessage
      ? { code: row.errorCode, message: row.errorMessage, details: row.errorDetails ?? null }
      : null,
  queuedAt: row.queuedAt?.toISOString() ?? null,
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});
