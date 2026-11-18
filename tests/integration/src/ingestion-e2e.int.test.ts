import { buildApp } from '@narada/api';
import { chunks, documentVersions } from '@narada/database';
import { createWorkerLoop, type WorkerLoop } from '@narada/ingestion-worker';
import { createLogger } from '@narada/shared';
import {
  buildMultipart,
  buildPdf,
  createTempBlobStore,
  createTestDatabase,
  insertSource,
  resetDatabase,
} from '@narada/test-utils';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The whole M2 workflow over HTTP: submit → register → extract → chunk → store → query status,
 * using the real API, the real worker loop, real PostgreSQL and a real on-disk blob store.
 */

const handle = createTestDatabase();
const { db } = handle;
const blobs = createTempBlobStore();
let app: FastifyInstance;
let worker: WorkerLoop;
let sourceId: string;
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  const logger = createLogger({ name: 'e2e', level: 'silent' });
  app = await buildApp({ db, logger, blobs: blobs.store, maxUploadBytes: 5 * 1024 * 1024 });
  await app.ready();
  worker = createWorkerLoop(db, { db, blobs: blobs.store, heartbeatMs: 1000 }, { pollIntervalMs: 20, staleJobMs: 60_000, maxAttempts: 3 });
});
beforeEach(async () => {
  await rm(join(blobs.dir, 'sha256'), { recursive: true, force: true });
  await resetDatabase(db);
  sourceId = (await insertSource(db, { title: 'E2E Source', author: 'Test Author' })).id;
});
afterEach(async () => {
  await worker.stop();
});
afterAll(async () => {
  await app.close();
  await handle.close();
  blobs.cleanup();
});

async function upload(filename: string, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/documents', ...buildMultipart({ sourceId, ...fields }, { filename, bytes }) });
  return { status: res.statusCode, body: res.json() };
}
const status = async (id: string) => (await app.inject({ method: 'GET', url: `/v1/documents/${id}` })).json();
const retry = (id: string) => app.inject({ method: 'POST', url: `/v1/documents/${id}/retry` });

/** Runs the worker loop one job at a time until the queue is empty. */
async function drain(max = 10) {
  for (let i = 0; i < max; i++) if ((await worker.runOnce()) === null) return;
  throw new Error('queue did not drain');
}

const paragraphs = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => Array.from({ length: 70 }, (_, j) => `${tag}${i}_${j}`).join(' ')).join('\n\n');

describe('full ingestion over HTTP', () => {
  it('PDF: pending → completed, with page attribution, warnings and a PDF-derived title', async () => {
    const pdf = buildPdf(
      [
        { lines: [{ text: 'Introduction', size: 22 }, { text: 'Rama is the hero of the epic.' }, { text: 'He keeps his promise.' }] },
        { lines: [] },
        { lines: [{ text: 'Chapter Two', size: 22 }, { text: 'Sita accompanies him to the forest.' }] },
      ],
      { title: 'The Epic' },
    );
    const { status: code, body } = await upload('upload.pdf', pdf);
    expect(code).toBe(202);
    const id = body.document.id;

    const pending = await status(id);
    expect(pending.latestJob).toMatchObject({ status: 'PENDING' });
    expect(pending.chunkCount).toBe(0);

    await drain();
    const done = await status(id);
    expect(done.latestJob).toMatchObject({ status: 'COMPLETED', stage: 'store', error: null });
    expect(done.document).toMatchObject({ title: 'The Epic', titleOrigin: 'extracted' });
    expect(done.latestVersion).toMatchObject({ pageCount: 3 });
    expect(done.latestVersion.extraction.warnings).toEqual([expect.objectContaining({ code: 'EMPTY_PAGES', pages: [2] })]);
    expect(done.chunkCount).toBe(2);

    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(rows.map((r) => [r.headingPath, r.pageStart, r.pageEnd])).toEqual([[['Introduction'], 1, 1], [['Chapter Two'], 3, 3]]);
    expect(rows[1]!.content).toContain('Sita accompanies him');
  });

  it('TXT: Devanagari survives the whole pipeline byte for byte', async () => {
    const text = 'रामो विग्रहवान् धर्मः।\nसत्यं वद, धर्मं चर॥\n\nधर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः।';
    const { body } = await upload('गीता.txt', enc(text));
    await drain();
    const details = await status(body.document.id);
    expect(details.latestJob.status).toBe('COMPLETED');
    expect(details.document.title).toBe('गीता');
    const rows = await db.select().from(chunks);
    expect(rows.map((r) => r.content).join('\n\n')).toBe(text);
    expect(rows[0]!.content).not.toContain('�');
  });

  it('Markdown: structure, headings and offsets survive', async () => {
    const md = `# Handbook\n\nWelcome.\n\n## Setup\n\n${paragraphs('s', 4)}\n\n| k | v |\n|---|---|\n| a | 1 |\n\n## Usage\n\n\`\`\`sh\nrun --fast\n\`\`\`\n`;
    const { body } = await upload('handbook.md', enc(md));
    await drain();
    const details = await status(body.document.id);
    expect(details.latestJob.status).toBe('COMPLETED');
    expect(details.document).toMatchObject({ title: 'Handbook', titleOrigin: 'extracted' });

    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(rows[0]).toMatchObject({ headingPath: ['Handbook'], sectionId: '1' });
    expect(rows.at(-1)).toMatchObject({ headingPath: ['Handbook', 'Usage'], sectionId: '1.2' });
    expect(rows.at(-1)!.content).toBe('run --fast');
    for (const row of rows) expect(md.slice(row.charStart!, row.charEnd!).length).toBeGreaterThan(0);
  });

  it('re-uploading identical content never queues or creates anything', async () => {
    const bytes = enc(paragraphs('d', 3));
    const first = await upload('a.txt', bytes);
    await drain();
    const chunksBefore = (await db.select().from(chunks)).length;
    const again = await upload('a.txt', bytes);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduplicated: true, job: { status: 'COMPLETED' } });
    expect(await worker.runOnce()).toBeNull();
    expect((await db.select().from(chunks)).length).toBe(chunksBefore);
    expect(again.body.document.id).toBe(first.body.document.id);
  });

  it('a new version is processed independently and the old version stays queryable', async () => {
    const v1 = await upload('doc.txt', enc(paragraphs('old', 3)));
    await drain();
    const v2 = await upload('doc.txt', enc(paragraphs('new', 3)), { documentId: v1.body.document.id });
    expect(v2.body.version.versionNumber).toBe(2);
    await drain();
    const details = await status(v1.body.document.id);
    expect(details.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(details.latestVersion.versionNumber).toBe(2);
    const all = await db.select().from(chunks);
    expect(new Set(all.map((c) => c.documentVersionId)).size).toBe(2);
  });
});

describe('failure, observability and retry over HTTP', () => {
  it('a scanned PDF is reported FAILED/OCR_REQUIRED, with no chunks; retry creates a new job that fails the same way', async () => {
    const { body } = await upload('scan.pdf', buildPdf([{ image: true }, { image: true }]));
    const id = body.document.id;
    await drain();

    const failed = await status(id);
    expect(failed.latestJob).toMatchObject({ status: 'FAILED', stage: 'extract', error: { code: 'OCR_REQUIRED' } });
    expect(failed.latestJob.error.message).toMatch(/OCR/i);
    expect(failed.latestVersion.extraction).toMatchObject({ status: 'failed' });
    expect(failed.chunkCount).toBe(0);

    const queued = await retry(id);
    expect(queued.statusCode).toBe(202);
    expect(queued.json().job).toMatchObject({ status: 'PENDING', retryOfJobId: failed.latestJob.id });
    await drain();
    const again = await status(id);
    expect(again.latestJob).toMatchObject({ status: 'FAILED', error: { code: 'OCR_REQUIRED' } });
    expect(again.latestJob.id).not.toBe(failed.latestJob.id);
  });

  it('a transient failure is recoverable: blob lost, restored, retried to completion', async () => {
    const bytes = enc(paragraphs('rec', 4));
    const { body } = await upload('a.txt', bytes);
    const id = body.document.id;
    const [version] = await db.select().from(documentVersions);
    await rm(join(blobs.dir, version!.storageKey));

    await drain();
    expect((await status(id)).latestJob).toMatchObject({ status: 'FAILED', error: { code: 'BLOB_MISSING' } });

    await blobs.store.put(bytes);
    expect((await retry(id)).statusCode).toBe(202);
    await drain();
    const recovered = await status(id);
    expect(recovered.latestJob).toMatchObject({ status: 'COMPLETED', error: null });
    expect(recovered.chunkCount).toBeGreaterThan(0);
  });

  it('retrying a completed ingestion is refused', async () => {
    const { body } = await upload('a.txt', enc('plain document text'));
    await drain();
    const res = await retry(body.document.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RETRY_NOT_ALLOWED');
  });
});

describe('worker loop', () => {
  it('picks up work on its own, and stop() waits for it to finish', async () => {
    worker.start();
    const { body } = await upload('a.txt', enc(paragraphs('auto', 3)));
    const deadline = Date.now() + 15_000;
    let details = await status(body.document.id);
    while (details.latestJob.status !== 'COMPLETED' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      details = await status(body.document.id);
    }
    expect(details.latestJob.status).toBe('COMPLETED');
    await worker.stop();
    expect(await worker.runOnce()).toBeNull();
  });
});
