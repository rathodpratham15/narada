import { isUniqueViolation, sources, type Database, type LicenseKind, type SourceRow, type SourceType } from '@narada/database';
import { appErrors } from '@narada/shared';
import { eq, sql } from 'drizzle-orm';
import type { CreateSourceInput } from './schemas';

/** API-facing source. Absent metadata is `null`; nothing is defaulted or invented. */
export interface Source {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  sourceType: SourceType;
  originalUrl: string | null;
  originalLanguage: string | null;
  publicationDate: string | null;
  edition: string | null;
  license: { kind: LicenseKind; url: string | null; notes: string | null };
  permissions: { allowIndexing: boolean; allowQuotation: boolean; allowRedistribution: boolean };
  contentChecksum: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    publisher: row.publisher,
    sourceType: row.sourceType,
    originalUrl: row.originalUrl,
    originalLanguage: row.originalLanguage,
    publicationDate: row.publicationDate,
    edition: row.edition,
    license: { kind: row.licenseKind, url: row.licenseUrl, notes: row.licenseNotes },
    permissions: {
      allowIndexing: row.allowIndexing,
      allowQuotation: row.allowQuotation,
      allowRedistribution: row.allowRedistribution,
    },
    contentChecksum: row.contentChecksum,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createSource(db: Database, input: CreateSourceInput): Promise<Source> {
  try {
    const [row] = await db
      .insert(sources)
      .values({
        title: input.title,
        author: input.author,
        publisher: input.publisher,
        sourceType: input.sourceType,
        originalUrl: input.originalUrl,
        originalLanguage: input.originalLanguage,
        publicationDate: input.publicationDate,
        edition: input.edition,
        licenseKind: input.license.kind,
        licenseUrl: input.license.url,
        licenseNotes: input.license.notes,
        allowIndexing: input.permissions.allowIndexing,
        allowQuotation: input.permissions.allowQuotation,
        allowRedistribution: input.permissions.allowRedistribution,
        contentChecksum: input.contentChecksum,
      })
      .returning();
    if (!row) throw appErrors.internal(new Error('insert into sources returned no row'));
    return toSource(row);
  } catch (error) {
    if (isUniqueViolation(error, 'sources_identity_unique')) {
      const [existing] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(
          sql`${sources.title} = ${input.title}
            and ${sources.author} is not distinct from ${input.author}
            and ${sources.publisher} is not distinct from ${input.publisher}
            and ${sources.edition} is not distinct from ${input.edition}`,
        )
        .limit(1);
      if (existing) throw appErrors.sourceAlreadyExists(existing.id);
    }
    throw error;
  }
}

export async function findSource(db: Database, id: string): Promise<Source | null> {
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  return row ? toSource(row) : null;
}

export async function requireSource(db: Database, id: string): Promise<Source> {
  const source = await findSource(db, id);
  if (!source) throw appErrors.sourceNotFound(id);
  return source;
}

/** Legal gate used before any ingestion: throws unless the source permits indexing. */
export function assertIndexable(source: Pick<Source, 'id' | 'permissions'>): void {
  if (!source.permissions.allowIndexing) throw appErrors.indexingNotPermitted(source.id);
}
