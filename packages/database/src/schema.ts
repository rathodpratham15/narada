import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Custom column types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * pgvector `vector` with NO fixed dimension (ADR 0004). Dimension integrity is enforced by
 * `chunk_embeddings_dimensions_match` and by the per-model partial HNSW indexes.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(',')
      .map((n) => Number(n)),
});

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const SOURCE_TYPES = ['book', 'scripture', 'article', 'paper', 'web_page', 'report', 'other'] as const;
export const LICENSE_KINDS = [
  'public_domain',
  'cc0',
  'cc_by',
  'cc_by_sa',
  'cc_by_nc',
  'licensed',
  'permission_granted',
  'proprietary',
  'unknown',
] as const;
export const INGESTION_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export const TITLE_ORIGINS = ['declared', 'extracted', 'filename'] as const;

export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES);
export const licenseKindEnum = pgEnum('license_kind', LICENSE_KINDS);
export const ingestionStatusEnum = pgEnum('ingestion_status', INGESTION_STATUSES);

export type SourceType = (typeof SOURCE_TYPES)[number];
export type LicenseKind = (typeof LICENSE_KINDS)[number];
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];
export type TitleOrigin = (typeof TITLE_ORIGINS)[number];

/** Structured location of a chunk. Only `page` is produced today; the rest are reserved (see overview.md). */
export type ChunkLocator =
  | { kind: 'page'; page: number }
  | { kind: 'page_range'; pageStart: number; pageEnd: number }
  | { kind: 'text_range'; start: number; end: number }
  | { kind: 'section'; headingPath: string[] }
  | { kind: 'verse'; work: string; book?: string; chapter?: string; verse: string }
  | { kind: 'commentary'; on: string; author?: string };

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* -------------------------------------------------------------------------- */
/* sources                                                                    */
/* -------------------------------------------------------------------------- */

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    author: text('author'),
    publisher: text('publisher'),
    sourceType: sourceTypeEnum('source_type').notNull(),
    originalUrl: text('original_url'),
    originalLanguage: text('original_language'),
    publicationDate: text('publication_date'),
    edition: text('edition'),
    licenseKind: licenseKindEnum('license_kind').notNull(),
    licenseUrl: text('license_url'),
    licenseNotes: text('license_notes'),
    allowIndexing: boolean('allow_indexing').notNull().default(false),
    allowQuotation: boolean('allow_quotation').notNull().default(false),
    allowRedistribution: boolean('allow_redistribution').notNull().default(false),
    contentChecksum: text('content_checksum'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sources_identity_unique').on(t.title, t.author, t.publisher, t.edition).nullsNotDistinct(),
    check('sources_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    check('sources_original_url_http', sql`${t.originalUrl} is null or ${t.originalUrl} ~ '^https?://'`),
    check(
      'sources_original_language_bcp47',
      sql`${t.originalLanguage} is null or ${t.originalLanguage} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    check(
      'sources_publication_date_format',
      sql`${t.publicationDate} is null or ${t.publicationDate} ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'`,
    ),
    check(
      'sources_content_checksum_sha256',
      sql`${t.contentChecksum} is null or ${t.contentChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'sources_indexing_requires_legal_basis',
      sql`${t.allowIndexing} = false or ${t.licenseKind} not in ('unknown', 'proprietary')`,
    ),
    check(
      'sources_licence_evidence_required',
      sql`${t.licenseKind} not in ('licensed', 'permission_granted') or length(btrim(coalesce(${t.licenseNotes}, ''))) > 0`,
    ),
    check('sources_quotation_requires_indexing', sql`${t.allowQuotation} = false or ${t.allowIndexing} = true`),
    check(
      'sources_redistribution_requires_indexing',
      sql`${t.allowRedistribution} = false or ${t.allowIndexing} = true`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* documents + versions                                                       */
/* -------------------------------------------------------------------------- */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    titleOrigin: text('title_origin').$type<TitleOrigin>().notNull(),
    originalLanguage: text('original_language'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('documents_source_id_idx').on(t.sourceId),
    check('documents_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    check('documents_title_origin_valid', sql`${t.titleOrigin} in ('declared', 'extracted', 'filename')`),
    check(
      'documents_original_language_bcp47',
      sql`${t.originalLanguage} is null or ${t.originalLanguage} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    contentSha256: text('content_sha256').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    originalFilename: text('original_filename'),
    // Content-addressed and therefore NOT unique: identical bytes under two sources share one blob.
    storageKey: text('storage_key').notNull(),
    pageCount: integer('page_count'),
    extractedTitle: text('extracted_title'),
    detectedLanguage: text('detected_language'),
    detectedLanguageConfidence: real('detected_language_confidence'),
    extractionMeta: jsonb('extraction_meta').$type<Record<string, unknown>>(),
    chunkingConfig: jsonb('chunking_config').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('document_versions_document_version_unique').on(t.documentId, t.versionNumber),
    // The idempotency key: identical bytes within one source are ingested once.
    unique('document_versions_source_content_unique').on(t.sourceId, t.contentSha256),
    check('document_versions_version_positive', sql`${t.versionNumber} > 0`),
    check('document_versions_byte_size_positive', sql`${t.byteSize} > 0`),
    check('document_versions_sha256_format', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check('document_versions_page_count_positive', sql`${t.pageCount} is null or ${t.pageCount} > 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* chunks                                                                     */
/* -------------------------------------------------------------------------- */

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentVersionId: uuid('document_version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentSha256: text('content_sha256').notNull(),
    tokenEstimate: integer('token_estimate').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    headingPath: text('heading_path').array().notNull().default(sql`'{}'::text[]`),
    /** Ordinal section path derived from heading order, e.g. "2.1". Null before the first heading. */
    sectionId: text('section_id'),
    /** UTF-16 offsets of the containing blocks. For 'page_text' they are relative to the page's text. */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    offsetBasis: text('offset_basis').$type<'document_text' | 'page_text'>(),
    extractionMethod: text('extraction_method').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    chunkingConfigHash: text('chunking_config_hash').notNull(),
    locator: jsonb('locator').$type<ChunkLocator>().notNull(),
    language: text('language'),
    // 'simple' config: no English stemming, so other languages are not mangled (risk R4).
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector('simple', content)`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('chunks_version_index_unique').on(t.documentVersionId, t.chunkIndex),
    index('chunks_content_tsv_idx').using('gin', t.contentTsv),
    index('chunks_source_id_idx').on(t.sourceId),
    index('chunks_document_id_idx').on(t.documentId),
    check('chunks_index_non_negative', sql`${t.chunkIndex} >= 0`),
    check('chunks_content_not_blank', sql`length(btrim(${t.content})) > 0`),
    check('chunks_token_estimate_positive', sql`${t.tokenEstimate} > 0`),
    check('chunks_page_order', sql`${t.pageStart} is null or ${t.pageEnd} is null or ${t.pageEnd} >= ${t.pageStart}`),
    check('chunks_page_positive', sql`${t.pageStart} is null or ${t.pageStart} > 0`),
    check(
      'chunks_offsets_paired',
      sql`(${t.charStart} is null) = (${t.charEnd} is null) and (${t.charStart} is null) = (${t.offsetBasis} is null)`,
    ),
    // For 'page_text' offsets, a chunk that spans pages starts on page N's text and ends on a LATER page's text,
    // so its end offset may be smaller than its start offset. Within one page, or for 'document_text', end >= start.
    check(
      'chunks_offsets_valid',
      sql`${t.charStart} is null or (${t.charStart} >= 0 and ${t.charEnd} >= 0 and (${t.charEnd} >= ${t.charStart} or (${t.offsetBasis} = 'page_text' and ${t.pageEnd} > ${t.pageStart})))`,
    ),
    check(
      'chunks_offset_basis_valid',
      sql`${t.offsetBasis} is null or ${t.offsetBasis} in ('document_text', 'page_text')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* embeddings                                                                 */
/* -------------------------------------------------------------------------- */

export const embeddingModels = pgTable(
  'embedding_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('embedding_models_identity_unique').on(t.provider, t.model, t.dimensions),
    check('embedding_models_dimensions_range', sql`${t.dimensions} between 1 and 16000`),
  ],
);

export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    embeddingModelId: uuid('embedding_model_id')
      .notNull()
      .references(() => embeddingModels.id, { onDelete: 'restrict' }),
    dimensions: integer('dimensions').notNull(),
    embedding: vector('embedding').notNull(),
    promptTokens: integer('prompt_tokens'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.embeddingModelId] }),
    index('chunk_embeddings_model_idx').on(t.embeddingModelId),
    check('chunk_embeddings_dimensions_match', sql`vector_dims(${t.embedding}) = ${t.dimensions}`),
  ],
);

/* -------------------------------------------------------------------------- */
/* ingestion_jobs                                                             */
/* -------------------------------------------------------------------------- */

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentVersionId: uuid('document_version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'restrict' }),
    status: ingestionStatusEnum('status').notNull().default('PENDING'),
    stage: text('stage'),
    attempt: integer('attempt').notNull().default(0),
    retryOfJobId: uuid('retry_of_job_id').references((): AnyPgColumn => ingestionJobs.id, {
      onDelete: 'set null',
    }),
    embeddingModelId: uuid('embedding_model_id').references(() => embeddingModels.id, {
      onDelete: 'restrict',
    }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorDetails: jsonb('error_details').$type<Record<string, unknown>>(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ingestion_jobs_version_idx').on(t.documentVersionId),
    index('ingestion_jobs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
    // At most one active job per version.
    uniqueIndex('ingestion_jobs_one_active_per_version')
      .on(t.documentVersionId)
      .where(sql`${t.status} in ('PENDING', 'PROCESSING')`),
    check('ingestion_jobs_attempt_non_negative', sql`${t.attempt} >= 0`),
    check(
      'ingestion_jobs_stage_valid',
      sql`${t.stage} is null or ${t.stage} in ('extract', 'chunk', 'embed', 'store')`,
    ),
    check(
      'ingestion_jobs_failed_has_error',
      sql`${t.status} <> 'FAILED' or (${t.errorCode} is not null and ${t.errorMessage} is not null)`,
    ),
    check('ingestion_jobs_completed_has_finish', sql`${t.status} <> 'COMPLETED' or ${t.finishedAt} is not null`),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type IngestionJobRow = typeof ingestionJobs.$inferSelect;
