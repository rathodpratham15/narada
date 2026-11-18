import {
  createTestDatabase,
  insertChunk,
  insertDocument,
  insertDocumentTree,
  insertSource,
  insertVersion,
  resetDatabase,
} from '@narada/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChunkLocator,
  chunkEmbeddings,
  chunks,
  embeddingModels,
  getPgError,
  ingestionJobs,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  sources,
  documentVersions,
} from '@narada/database';

const handle = createTestDatabase();
const { db } = handle;

beforeEach(() => resetDatabase(db));
afterAll(() => handle.close());

/** Asserts the promise fails with a specific PostgreSQL error code and, optionally, constraint name. */
async function expectPgError(promise: Promise<unknown>, code: string, constraint?: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e ?? new Error('rejected with an empty value'),
  );
  expect(error, 'expected the statement to be rejected').toBeDefined();
  const info = getPgError(error);
  expect(info?.code).toBe(code);
  if (constraint) expect(info?.constraint).toBe(constraint);
}

describe('sources constraints', () => {
  it('treats NULLs as equal in the identity key, so duplicates are rejected', async () => {
    await insertSource(db, { title: 'Same', author: null, publisher: null, edition: null });
    await expectPgError(
      insertSource(db, { title: 'Same', author: null, publisher: null, edition: null }),
      PG_UNIQUE_VIOLATION,
      'sources_identity_unique',
    );
  });

  it('allows the same title when another identity field differs', async () => {
    await insertSource(db, { title: 'Same', edition: '1st' });
    await expect(insertSource(db, { title: 'Same', edition: '2nd' })).resolves.toBeDefined();
  });

  it('rejects a blank title', async () => {
    await expectPgError(insertSource(db, { title: '   ' }), PG_CHECK_VIOLATION, 'sources_title_not_blank');
  });

  it.each(['unknown', 'proprietary'] as const)('rejects indexing under a %s licence', async (licenseKind) => {
    await expectPgError(
      insertSource(db, { licenseKind, allowIndexing: true, allowQuotation: false, allowRedistribution: false }),
      PG_CHECK_VIOLATION,
      'sources_indexing_requires_legal_basis',
    );
  });

  it('allows unknown-licence sources that are not indexable', async () => {
    await expect(
      insertSource(db, { licenseKind: 'unknown', allowIndexing: false, allowQuotation: false, allowRedistribution: false }),
    ).resolves.toBeDefined();
  });

  it.each(['licensed', 'permission_granted'] as const)('requires evidence notes for %s', async (licenseKind) => {
    await expectPgError(
      insertSource(db, { licenseKind, licenseNotes: null }),
      PG_CHECK_VIOLATION,
      'sources_licence_evidence_required',
    );
    await expectPgError(
      insertSource(db, { licenseKind, licenseNotes: '  ' }),
      PG_CHECK_VIOLATION,
      'sources_licence_evidence_required',
    );
  });

  it('rejects quotation or redistribution without indexing', async () => {
    await expectPgError(
      insertSource(db, { allowIndexing: false, allowQuotation: true, allowRedistribution: false }),
      PG_CHECK_VIOLATION,
      'sources_quotation_requires_indexing',
    );
    await expectPgError(
      insertSource(db, { allowIndexing: false, allowQuotation: false, allowRedistribution: true }),
      PG_CHECK_VIOLATION,
      'sources_redistribution_requires_indexing',
    );
  });

  it('rejects malformed dates, languages, URLs and checksums', async () => {
    await expectPgError(insertSource(db, { publicationDate: '1891-7' }), PG_CHECK_VIOLATION, 'sources_publication_date_format');
    await expectPgError(insertSource(db, { originalLanguage: 'English language' }), PG_CHECK_VIOLATION, 'sources_original_language_bcp47');
    await expectPgError(insertSource(db, { originalUrl: 'ftp://x.org' }), PG_CHECK_VIOLATION, 'sources_original_url_http');
    await expectPgError(insertSource(db, { contentChecksum: 'XYZ' }), PG_CHECK_VIOLATION, 'sources_content_checksum_sha256');
  });

  it('defaults all permissions to false when unspecified', async () => {
    const [row] = await db
      .insert(sources)
      .values({ title: 'Defaults', sourceType: 'other', licenseKind: 'unknown' })
      .returning();
    expect(row).toMatchObject({ allowIndexing: false, allowQuotation: false, allowRedistribution: false });
  });
});

describe('document and version constraints', () => {
  it('enforces the idempotency key: identical content within one source is stored once', async () => {
    const { source, document, version } = await insertDocumentTree(db);
    const second = await insertDocument(db, source.id);
    await expectPgError(
      insertVersion(db, second.id, source.id, { contentSha256: version.contentSha256, storageKey: 'sha256/other' }),
      PG_UNIQUE_VIOLATION,
      'document_versions_source_content_unique',
    );
    expect(document.id).not.toBe(second.id);
  });

  it('allows the same content under a different source', async () => {
    const { version } = await insertDocumentTree(db);
    const other = await insertSource(db);
    const otherDoc = await insertDocument(db, other.id);
    await expect(
      insertVersion(db, otherDoc.id, other.id, { contentSha256: version.contentSha256, storageKey: 'sha256/other-source' }),
    ).resolves.toBeDefined();
  });

  it('keeps version numbers unique per document', async () => {
    const { source, document } = await insertDocumentTree(db);
    await expectPgError(
      insertVersion(db, document.id, source.id, { versionNumber: 1 }),
      PG_UNIQUE_VIOLATION,
      'document_versions_document_version_unique',
    );
    await expect(insertVersion(db, document.id, source.id, { versionNumber: 2 })).resolves.toBeDefined();
  });

  it('rejects invalid checksums, sizes and title origins', async () => {
    const { source, document } = await insertDocumentTree(db);
    await expectPgError(
      insertVersion(db, document.id, source.id, { versionNumber: 2, contentSha256: 'NOT-A-HASH' }),
      PG_CHECK_VIOLATION,
      'document_versions_sha256_format',
    );
    await expectPgError(
      insertVersion(db, document.id, source.id, { versionNumber: 3, byteSize: 0 }),
      PG_CHECK_VIOLATION,
      'document_versions_byte_size_positive',
    );
    await expectPgError(
      insertDocument(db, source.id, { titleOrigin: 'guessed' as never }),
      PG_CHECK_VIOLATION,
      'documents_title_origin_valid',
    );
  });

  it('refuses to delete a source that still has documents (provenance is protected)', async () => {
    const { source } = await insertDocumentTree(db);
    await expectPgError(db.delete(sources).where(eq(sources.id, source.id)), PG_FOREIGN_KEY_VIOLATION);
  });

  it('refuses to delete a version that still has ingestion history', async () => {
    const { version } = await insertDocumentTree(db);
    await db.insert(ingestionJobs).values({ documentVersionId: version.id });
    await expectPgError(
      db.delete(documentVersions).where(eq(documentVersions.id, version.id)),
      PG_FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('chunk constraints and full-text column', () => {
  it('requires a unique index per version', async () => {
    const { parent } = await insertDocumentTree(db);
    await insertChunk(db, parent, { chunkIndex: 0 });
    await expectPgError(insertChunk(db, parent, { chunkIndex: 0 }), PG_UNIQUE_VIOLATION, 'chunks_version_index_unique');
  });

  it('rejects blank content and inverted page ranges', async () => {
    const { parent } = await insertDocumentTree(db);
    await expectPgError(insertChunk(db, parent, { chunkIndex: 1, content: '  ' }), PG_CHECK_VIOLATION, 'chunks_content_not_blank');
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 2, pageStart: 5, pageEnd: 3 }),
      PG_CHECK_VIOLATION,
      'chunks_page_order',
    );
  });

  it('removes chunks when their version is deleted (cascade)', async () => {
    const { parent, version } = await insertDocumentTree(db);
    await insertChunk(db, parent);
    await db.delete(documentVersions).where(eq(documentVersions.id, version.id));
    const remaining = await db.select().from(chunks);
    expect(remaining).toHaveLength(0);
  });

  it('populates the generated tsvector for keyword search', async () => {
    const { parent } = await insertDocumentTree(db);
    const chunk = await insertChunk(db, parent, { content: 'Rama accepted exile to honour his father’s word.' });
    const hits = await db
      .select({ id: chunks.id })
      .from(chunks)
      .where(sql`${chunks.contentTsv} @@ plainto_tsquery('simple', 'exile')`);
    expect(hits.map((h) => h.id)).toEqual([chunk.id]);
  });

  // Risk R4: Postgres' text-search parser and Devanagari combining marks. This pins current behaviour.
  it('finds Devanagari words with the simple configuration', async () => {
    const { parent } = await insertDocumentTree(db);
    const chunk = await insertChunk(db, parent, { content: 'रामो विग्रहवान् धर्मः', language: 'sa' });
    for (const term of ['धर्मः', 'रामो']) {
      const hits = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(sql`${chunks.contentTsv} @@ plainto_tsquery('simple', ${term})`);
      expect(hits.map((h) => h.id), `term ${term}`).toEqual([chunk.id]);
    }
  });
});

describe('embedding constraints', () => {
  async function createModel(dimensions: number) {
    const [model] = await db
      .insert(embeddingModels)
      .values({ provider: 'test', model: `m-${dimensions}`, dimensions })
      .returning();
    if (!model) throw new Error('model not created');
    return model;
  }

  it('stores and reads back a vector of the declared dimension', async () => {
    const { parent } = await insertDocumentTree(db);
    const chunk = await insertChunk(db, parent);
    const model = await createModel(3);
    await db.insert(chunkEmbeddings).values({
      chunkId: chunk.id,
      embeddingModelId: model.id,
      dimensions: 3,
      embedding: [0.25, -0.5, 1],
      promptTokens: 7,
    });
    const [row] = await db.select().from(chunkEmbeddings);
    expect(row?.embedding).toEqual([0.25, -0.5, 1]);
    expect(row?.promptTokens).toBe(7);
  });

  it('rejects a vector whose length differs from the declared dimensions', async () => {
    const { parent } = await insertDocumentTree(db);
    const chunk = await insertChunk(db, parent);
    const model = await createModel(4);
    await expectPgError(
      db.insert(chunkEmbeddings).values({ chunkId: chunk.id, embeddingModelId: model.id, dimensions: 4, embedding: [1, 2, 3] }),
      PG_CHECK_VIOLATION,
      'chunk_embeddings_dimensions_match',
    );
  });

  it('allows one embedding per chunk per model, and several models side by side', async () => {
    const { parent } = await insertDocumentTree(db);
    const chunk = await insertChunk(db, parent);
    const small = await createModel(3);
    const large = await createModel(5);
    await db.insert(chunkEmbeddings).values({ chunkId: chunk.id, embeddingModelId: small.id, dimensions: 3, embedding: [1, 0, 0] });
    await db.insert(chunkEmbeddings).values({ chunkId: chunk.id, embeddingModelId: large.id, dimensions: 5, embedding: [1, 0, 0, 0, 0] });
    await expectPgError(
      db.insert(chunkEmbeddings).values({ chunkId: chunk.id, embeddingModelId: small.id, dimensions: 3, embedding: [0, 1, 0] }),
      PG_UNIQUE_VIOLATION,
    );
  });

  it('rejects absurd model dimensions', async () => {
    await expectPgError(
      db.insert(embeddingModels).values({ provider: 'test', model: 'zero', dimensions: 0 }),
      PG_CHECK_VIOLATION,
      'embedding_models_dimensions_range',
    );
  });
});

describe('ingestion_jobs constraints', () => {
  it('allows only one active job per version', async () => {
    const { version } = await insertDocumentTree(db);
    await db.insert(ingestionJobs).values({ documentVersionId: version.id });
    await expectPgError(
      db.insert(ingestionJobs).values({ documentVersionId: version.id, status: 'PROCESSING' }),
      PG_UNIQUE_VIOLATION,
      'ingestion_jobs_one_active_per_version',
    );
  });

  it('allows a new job once the previous one has failed, preserving history', async () => {
    const { version } = await insertDocumentTree(db);
    const [first] = await db
      .insert(ingestionJobs)
      .values({ documentVersionId: version.id, status: 'FAILED', errorCode: 'EXTRACTION_FAILED', errorMessage: 'boom' })
      .returning();
    await db.insert(ingestionJobs).values({ documentVersionId: version.id, retryOfJobId: first!.id });
    const all = await db.select().from(ingestionJobs).where(eq(ingestionJobs.documentVersionId, version.id));
    expect(all).toHaveLength(2);
  });

  it('requires error details on FAILED jobs', async () => {
    const { version } = await insertDocumentTree(db);
    await expectPgError(
      db.insert(ingestionJobs).values({ documentVersionId: version.id, status: 'FAILED' }),
      PG_CHECK_VIOLATION,
      'ingestion_jobs_failed_has_error',
    );
  });

  it('requires a finish time on COMPLETED jobs', async () => {
    const { version } = await insertDocumentTree(db);
    await expectPgError(
      db.insert(ingestionJobs).values({ documentVersionId: version.id, status: 'COMPLETED' }),
      PG_CHECK_VIOLATION,
      'ingestion_jobs_completed_has_finish',
    );
  });

  it('rejects unknown stages', async () => {
    const { version } = await insertDocumentTree(db);
    await expectPgError(
      db.insert(ingestionJobs).values({ documentVersionId: version.id, stage: 'magic' }),
      PG_CHECK_VIOLATION,
      'ingestion_jobs_stage_valid',
    );
  });
});

describe('M2 provenance columns', () => {
  it('allows identical bytes under two sources to share one storage key (blobs are content-addressed)', async () => {
    const a = await insertDocumentTree(db);
    const other = await insertSource(db);
    const otherDoc = await insertDocument(db, other.id);
    await expect(
      insertVersion(db, otherDoc.id, other.id, { contentSha256: a.version.contentSha256, storageKey: a.version.storageKey }),
    ).resolves.toBeDefined();
  });

  it('requires offsets to be both present or both absent, ordered, and paired with a basis', async () => {
    const { parent } = await insertDocumentTree(db);
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 1, charStart: 5, charEnd: null, offsetBasis: 'document_text' }),
      PG_CHECK_VIOLATION,
      'chunks_offsets_paired',
    );
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 2, charStart: 9, charEnd: 3, offsetBasis: 'document_text' }),
      PG_CHECK_VIOLATION,
      'chunks_offsets_valid',
    );
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 3, charStart: 1, charEnd: 2, offsetBasis: null }),
      PG_CHECK_VIOLATION,
      'chunks_offsets_paired',
    );
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 4, charStart: 1, charEnd: 2, offsetBasis: 'bytes' as never }),
      PG_CHECK_VIOLATION,
      'chunks_offset_basis_valid',
    );
    await expect(insertChunk(db, parent, { chunkIndex: 5, charStart: null, charEnd: null, offsetBasis: null })).resolves.toBeDefined();
    await expect(insertChunk(db, parent, { chunkIndex: 6, charStart: 0, charEnd: 10, offsetBasis: 'page_text' })).resolves.toBeDefined();
  });

  it('lets a page-relative range end before it starts only when the chunk spans pages', async () => {
    const { parent } = await insertDocumentTree(db);
    // starts at 4000 on page 1, ends at 50 on page 2: legitimate for page_text offsets
    await expect(
      insertChunk(db, parent, { chunkIndex: 1, pageStart: 1, pageEnd: 2, charStart: 4000, charEnd: 50, offsetBasis: 'page_text' }),
    ).resolves.toBeDefined();
    // the same numbers within a single page are an error
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 2, pageStart: 3, pageEnd: 3, charStart: 4000, charEnd: 50, offsetBasis: 'page_text' }),
      PG_CHECK_VIOLATION,
      'chunks_offsets_valid',
    );
    // and document_text offsets are always ordered, whatever the pages
    await expectPgError(
      insertChunk(db, parent, { chunkIndex: 3, pageStart: 1, pageEnd: 2, charStart: 4000, charEnd: 50, offsetBasis: 'document_text' }),
      PG_CHECK_VIOLATION,
      'chunks_offsets_valid',
    );
  });

  it('refuses chunks without extraction method, chunker version or configuration hash', async () => {
    const { parent } = await insertDocumentTree(db);
    for (const field of ['extractionMethod', 'chunkerVersion', 'chunkingConfigHash'] as const) {
      await expectPgError(insertChunk(db, parent, { chunkIndex: 1, [field]: null as never }), '23502');
    }
  });

  it('stores and returns text_range, page_range and section locators', async () => {
    const { parent } = await insertDocumentTree(db);
    const locators: ChunkLocator[] = [
      { kind: 'text_range', start: 0, end: 9 },
      { kind: 'page_range', pageStart: 1, pageEnd: 2 },
      { kind: 'section', headingPath: ['A', 'B'] },
    ];
    for (const [i, locator] of locators.entries()) {
      const row = await insertChunk(db, parent, { chunkIndex: i, locator });
      expect(row.locator).toEqual(locator);
    }
  });
});
