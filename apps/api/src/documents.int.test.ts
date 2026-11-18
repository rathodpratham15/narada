import { createLogger } from '@narada/shared';
import { buildMultipart, createTempBlobStore, createTestDatabase, insertSource, resetDatabase } from '@narada/test-utils';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const handle = createTestDatabase();
const blobs = createTempBlobStore();
const MAX = 1024 * 1024;
let app: FastifyInstance;
let sourceId: string;

beforeAll(async () => {
  app = await buildApp({ db: handle.db, logger: createLogger({ name: 'api-test', level: 'silent' }), blobs: blobs.store, maxUploadBytes: MAX });
  await app.ready();
});
beforeEach(async () => {
  await resetDatabase(handle.db);
  sourceId = (await insertSource(handle.db)).id;
});
afterAll(async () => {
  await app.close();
  await handle.close();
  blobs.cleanup();
});

const enc = (s: string) => new TextEncoder().encode(s);
const upload = (fields: Record<string, string>, file?: { filename: string; bytes: Uint8Array; contentType?: string; field?: string }) =>
  app.inject({ method: 'POST', url: '/v1/documents', ...buildMultipart(fields, file) });

describe('POST /v1/documents', () => {
  it('accepts a file, returns 202 with document, version and a PENDING job', async () => {
    const res = await upload({ sourceId, title: 'My Title', language: 'sa' }, { filename: 'a.txt', bytes: enc('नमस्ते\n\nworld'), contentType: 'text/plain' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.deduplicated).toBe(false);
    expect(body.document).toMatchObject({ sourceId, title: 'My Title', titleOrigin: 'declared', originalLanguage: 'sa' });
    expect(body.version).toMatchObject({ versionNumber: 1, mimeType: 'text/plain', originalFilename: 'a.txt' });
    expect(body.version.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.job).toMatchObject({ status: 'PENDING', error: null });
  });

  it('returns 200 and deduplicated:true for identical content', async () => {
    const file = { filename: 'a.txt', bytes: enc('same bytes') };
    const first = await upload({ sourceId }, file);
    const second = await upload({ sourceId }, file);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ deduplicated: true });
    expect(second.json().document.id).toBe(first.json().document.id);
    expect(second.json().job.id).toBe(first.json().job.id);
  });

  it('inherits the source language when none is declared', async () => {
    const withLang = await insertSource(handle.db, { originalLanguage: 'hi' });
    const res = await upload({ sourceId: withLang.id }, { filename: 'a.txt', bytes: enc('hello') });
    expect(res.json().document.originalLanguage).toBe('hi');
  });

  it.each([
    ['no file part', {}, undefined, 'VALIDATION_ERROR'],
    ['invalid sourceId', { sourceId: 'not-a-uuid' }, { filename: 'a.txt', bytes: enc('x') }, 'VALIDATION_ERROR'],
    ['unknown field', { extra: 'nope' }, { filename: 'a.txt', bytes: enc('x') }, 'VALIDATION_ERROR'],
    ['bad language tag', { language: 'not a tag' }, { filename: 'a.txt', bytes: enc('x') }, 'VALIDATION_ERROR'],
    ['unsupported extension', {}, { filename: 'a.docx', bytes: enc('x') }, 'INVALID_FILE_TYPE'],
    ['binary disguised as text', {}, { filename: 'a.txt', bytes: Uint8Array.from([0x4d, 0x5a, 0, 0, 1]) }, 'INVALID_FILE_TYPE'],
    ['wrong declared type', {}, { filename: 'a.txt', bytes: enc('x'), contentType: 'application/x-msdownload' }, 'INVALID_FILE_TYPE'],
    ['file under the wrong field name', {}, { filename: 'a.txt', bytes: enc('x'), field: 'upload' }, 'VALIDATION_ERROR'],
  ])('rejects %s with 400 %s', async (_name, fields, file, code) => {
    const res = await upload({ sourceId, ...fields } as Record<string, string>, file);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect(res.json().error.requestId).toBeTruthy();
    const documents = await handle.db.query.documents.findMany();
    expect(documents).toHaveLength(0);
  });

  it('rejects a body that is not multipart', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/documents', payload: { sourceId } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns 404 for an unknown source', async () => {
    const res = await upload({ sourceId: '00000000-0000-4000-8000-000000000000' }, { filename: 'a.txt', bytes: enc('x') });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SOURCE_NOT_FOUND');
  });

  it('returns 403 for a source that does not permit indexing', async () => {
    const locked = await insertSource(handle.db, { licenseKind: 'proprietary', allowIndexing: false, allowQuotation: false, allowRedistribution: false });
    const res = await upload({ sourceId: locked.id }, { filename: 'a.txt', bytes: enc('x') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INDEXING_NOT_PERMITTED');
  });

  it('returns 413 FILE_TOO_LARGE past the upload limit, and stores nothing', async () => {
    const res = await upload({ sourceId }, { filename: 'big.txt', bytes: new Uint8Array(MAX + 1000).fill(97) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await handle.db.query.documents.findMany()).toHaveLength(0);
  });

  it('rejects a second file', async () => {
    const { payload, headers } = buildMultipart({ sourceId }, { filename: 'a.txt', bytes: enc('one') });
    const second = buildMultipart({}, { filename: 'b.txt', bytes: enc('two') });
    const boundary = /boundary=(.+)$/.exec(headers['content-type'])![1]!;
    const secondBoundary = /boundary=(.+)$/.exec(second.headers['content-type'])![1]!;
    const merged = Buffer.concat([
      payload.subarray(0, payload.length - Buffer.byteLength(`--${boundary}--\r\n`)),
      Buffer.from(second.payload.toString('latin1').replaceAll(secondBoundary, boundary), 'latin1'),
    ]);
    const res = await app.inject({ method: 'POST', url: '/v1/documents', payload: merged, headers });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await handle.db.query.documents.findMany()).toHaveLength(0);
  });
});

describe('GET /v1/documents/:id and retry', () => {
  it('reports status, version and a not-yet-processed job', async () => {
    const created = await upload({ sourceId }, { filename: 'a.txt', bytes: enc('some text') });
    const id = created.json().document.id;
    const res = await app.inject({ method: 'GET', url: `/v1/documents/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      document: { id },
      latestVersion: { versionNumber: 1, extraction: null },
      latestJob: { status: 'PENDING', stage: null, error: null },
      chunkCount: 0,
      versions: [{ versionNumber: 1 }],
    });
  });

  it('returns 400 for a malformed id and 404 for an unknown document', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/documents/nope' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/v1/documents/00000000-0000-4000-8000-000000000000' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('refuses to retry a job that has not failed (409) and a missing document (404)', async () => {
    const created = await upload({ sourceId }, { filename: 'a.txt', bytes: enc('some text') });
    const res = await app.inject({ method: 'POST', url: `/v1/documents/${created.json().document.id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RETRY_NOT_ALLOWED');
    const missing = await app.inject({ method: 'POST', url: '/v1/documents/00000000-0000-4000-8000-000000000000/retry' });
    expect(missing.statusCode).toBe(404);
  });
});
