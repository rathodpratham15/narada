import {
  chunks,
  documents,
  documentVersions,
  sources,
  type ChunkRow,
  type Database,
  type DocumentRow,
  type DocumentVersionRow,
  type SourceRow,
} from '@narada/database';
import { sha256Hex } from '@narada/shared';

type Overrides<T> = Partial<T>;

let counter = 0;
const unique = () => `${Date.now()}-${++counter}`;

/** Inserts directly through the ORM, bypassing service validation, so tests can probe DB constraints. */
export async function insertSource(db: Database, overrides: Overrides<typeof sources.$inferInsert> = {}): Promise<SourceRow> {
  const [row] = await db
    .insert(sources)
    .values({
      title: `Test Source ${unique()}`,
      sourceType: 'book',
      licenseKind: 'public_domain',
      allowIndexing: true,
      allowQuotation: true,
      allowRedistribution: true,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insertSource returned no row');
  return row;
}

export async function insertDocument(
  db: Database,
  sourceId: string,
  overrides: Overrides<typeof documents.$inferInsert> = {},
): Promise<DocumentRow> {
  const [row] = await db
    .insert(documents)
    .values({ sourceId, title: `Test Document ${unique()}`, titleOrigin: 'declared', ...overrides })
    .returning();
  if (!row) throw new Error('insertDocument returned no row');
  return row;
}

export async function insertVersion(
  db: Database,
  documentId: string,
  sourceId: string,
  overrides: Overrides<typeof documentVersions.$inferInsert> = {},
): Promise<DocumentVersionRow> {
  const content = `content-${unique()}`;
  const [row] = await db
    .insert(documentVersions)
    .values({
      documentId,
      sourceId,
      versionNumber: 1,
      contentSha256: sha256Hex(content),
      byteSize: content.length,
      mimeType: 'text/plain',
      storageKey: `sha256/${sha256Hex(content)}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insertVersion returned no row');
  return row;
}

export async function insertChunk(
  db: Database,
  parent: { documentVersionId: string; documentId: string; sourceId: string },
  overrides: Overrides<typeof chunks.$inferInsert> = {},
): Promise<ChunkRow> {
  const content = overrides.content ?? `chunk text ${unique()}`;
  const [row] = await db
    .insert(chunks)
    .values({
      ...parent,
      chunkIndex: 0,
      content,
      contentSha256: sha256Hex(content),
      tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
      locator: { kind: 'page', page: 1 },
      pageStart: 1,
      pageEnd: 1,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insertChunk returned no row');
  return row;
}

/** Creates source → document → version in one call. */
export async function insertDocumentTree(db: Database, sourceOverrides: Overrides<typeof sources.$inferInsert> = {}) {
  const source = await insertSource(db, sourceOverrides);
  const document = await insertDocument(db, source.id);
  const version = await insertVersion(db, document.id, source.id);
  return { source, document, version, parent: { documentVersionId: version.id, documentId: document.id, sourceId: source.id } };
}
