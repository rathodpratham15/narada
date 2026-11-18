import { createTestDatabase, resetDatabase } from '@narada/test-utils';
import { AppError } from '@narada/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createSourceSchema, type CreateSourceInput } from './schemas';
import { assertIndexable, createSource, findSource, requireSource } from './service';

const handle = createTestDatabase();
const { db } = handle;

beforeEach(() => resetDatabase(db));
afterAll(() => handle.close());

const parse = (input: unknown): CreateSourceInput => createSourceSchema.parse(input);

const full = {
  title: 'Valmiki Ramayana, Bala Kanda',
  author: 'Valmiki',
  publisher: 'Example Press',
  sourceType: 'scripture',
  originalUrl: 'https://example.org/ramayana',
  originalLanguage: 'sa',
  publicationDate: '1891',
  edition: 'First',
  license: { kind: 'public_domain', url: 'https://creativecommons.org/publicdomain/mark/1.0/', notes: 'Translator d. 1920' },
  permissions: { allowIndexing: true, allowQuotation: true, allowRedistribution: true },
  contentChecksum: 'ab'.repeat(32),
};

describe('createSource', () => {
  it('persists every field and returns them in the API shape', async () => {
    const created = await createSource(db, parse(full));
    expect(created).toMatchObject({
      title: full.title,
      author: 'Valmiki',
      publisher: 'Example Press',
      sourceType: 'scripture',
      originalUrl: full.originalUrl,
      originalLanguage: 'sa',
      publicationDate: '1891',
      edition: 'First',
      license: full.license,
      permissions: full.permissions,
      contentChecksum: full.contentChecksum,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(created.createdAt).getTime()).not.toBeNaN();
    expect(await findSource(db, created.id)).toEqual(created);
  });

  it('stores missing metadata as null rather than inventing values', async () => {
    const created = await createSource(db, parse({ title: 'Bare', sourceType: 'other', license: { kind: 'unknown' } }));
    expect(created.author).toBeNull();
    expect(created.publisher).toBeNull();
    expect(created.edition).toBeNull();
    expect(created.originalUrl).toBeNull();
    expect(created.originalLanguage).toBeNull();
    expect(created.publicationDate).toBeNull();
    expect(created.contentChecksum).toBeNull();
    expect(created.permissions).toEqual({ allowIndexing: false, allowQuotation: false, allowRedistribution: false });
  });

  it('reports a duplicate registration with the existing source id', async () => {
    const first = await createSource(db, parse(full));
    const error = await createSource(db, parse(full)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'SOURCE_ALREADY_EXISTS', httpStatus: 409, details: { existingSourceId: first.id } });
  });

  it('detects duplicates even when optional identity fields are null', async () => {
    const input = { title: 'No Author', sourceType: 'article', license: { kind: 'cc0' } };
    const first = await createSource(db, parse(input));
    await expect(createSource(db, parse(input))).rejects.toMatchObject({
      code: 'SOURCE_ALREADY_EXISTS',
      details: { existingSourceId: first.id },
    });
  });

  it('allows the same title with a different edition', async () => {
    await createSource(db, parse(full));
    await expect(createSource(db, parse({ ...full, edition: 'Second' }))).resolves.toBeDefined();
  });
});

describe('requireSource / findSource', () => {
  it('returns null for an unknown id', async () => {
    expect(await findSource(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('throws SOURCE_NOT_FOUND for an unknown id', async () => {
    await expect(requireSource(db, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      httpStatus: 404,
    });
  });
});

describe('assertIndexable (legal gate)', () => {
  it('passes for a source that permits indexing', async () => {
    const source = await createSource(db, parse(full));
    expect(() => assertIndexable(source)).not.toThrow();
  });

  it('throws INDEXING_NOT_PERMITTED otherwise', async () => {
    const source = await createSource(db, parse({ title: 'Locked', sourceType: 'book', license: { kind: 'proprietary' } }));
    expect(() => assertIndexable(source)).toThrow(AppError);
    try {
      assertIndexable(source);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INDEXING_NOT_PERMITTED', httpStatus: 403 });
    }
  });
});
