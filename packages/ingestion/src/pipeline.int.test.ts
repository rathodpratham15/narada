import { chunks, documents, documentVersions, ingestionJobs, type SourceRow } from '@narada/database';
import { buildPdf, createTempBlobStore, createTestDatabase, insertSource, resetDatabase, truncatePdf } from '@narada/test-utils';
import type { BlobStore } from '@narada/storage';
import { asc, count, eq } from 'drizzle-orm';
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDocumentDetails, retryDocument, submitDocument, type SubmitResult } from './documents';
import { claimNextJob, processJob, recoverStaleJobs, type ProcessDeps } from './process';
import { sha256Hex } from '@narada/shared';

const handle = createTestDatabase();
const { db } = handle;
const blobs = createTempBlobStore();
let source: SourceRow;

beforeEach(async () => {
  await rm(join(blobs.dir, 'sha256'), { recursive: true, force: true }); // blobs must not leak between tests
  await resetDatabase(db);
  source = await insertSource(db);
});
afterAll(async () => {
  await handle.close();
  blobs.cleanup();
});

const enc = (s: string) => new TextEncoder().encode(s);
const deps = (over: Partial<ProcessDeps> = {}): ProcessDeps => ({ db, blobs: blobs.store, ...over });

function submit(bytes: Uint8Array, filename: string, extra: { sourceId?: string; title?: string; documentId?: string } = {}) {
  return submitDocument(
    { db, blobs: blobs.store, maxUploadBytes: 1_000_000 },
    { sourceId: extra.sourceId ?? source.id, title: extra.title ?? null, documentId: extra.documentId ?? null, file: { bytes, filename, declaredType: null } },
  );
}

async function processNext(over: Partial<ProcessDeps> = {}) {
  const job = await claimNextJob(db);
  expect(job, 'a pending job should exist').not.toBeNull();
  return { job: job!, outcome: await processJob(deps(over), job!.id) };
}

const counts = async () => ({
  documents: (await db.select({ n: count() }).from(documents))[0]!.n,
  versions: (await db.select({ n: count() }).from(documentVersions))[0]!.n,
  jobs: (await db.select({ n: count() }).from(ingestionJobs))[0]!.n,
  chunks: (await db.select({ n: count() }).from(chunks))[0]!.n,
});

const blobFileCount = () => readdirSync(blobs.dir, { recursive: true }).filter((f) => !String(f).endsWith('/') && String(f).split('/').length === 3).length;

const longText = (tag: string, paragraphs = 12) =>
  Array.from({ length: paragraphs }, (_, i) => Array.from({ length: 60 }, (_, j) => `${tag}${i}x${j}`).join(' ')).join('\n\n');

describe('submission', () => {
  it('registers the upload with provenance, preserving the original bytes and checksum', async () => {
    const bytes = enc('Hello world.\n\nSecond paragraph.');
    const result = await submit(bytes, 'notes.txt');
    expect(result.deduplicated).toBe(false);
    expect(result.document).toMatchObject({ sourceId: source.id, title: 'notes', titleOrigin: 'filename' });
    expect(result.version).toMatchObject({ versionNumber: 1, contentSha256: sha256Hex(bytes), byteSize: bytes.length, mimeType: 'text/plain', originalFilename: 'notes.txt' });
    expect(result.job).toMatchObject({ status: 'PENDING', attempt: 0, error: null });
    expect(result.job!.queuedAt).not.toBeNull();

    const [version] = await db.select().from(documentVersions);
    expect(Array.from(await blobs.store.get(version!.storageKey))).toEqual(Array.from(bytes));
  });

  it('records a declared title as declared', async () => {
    const result = await submit(enc('x y z'), 'a.txt', { title: 'The Declared Title' });
    expect(result.document).toMatchObject({ title: 'The Declared Title', titleOrigin: 'declared' });
  });

  it('is idempotent: re-submitting identical bytes creates nothing', async () => {
    const bytes = enc('same content');
    const first = await submit(bytes, 'a.txt');
    const before = await counts();
    const second = await submit(bytes, 'renamed.txt');
    expect(second.deduplicated).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.version.id).toBe(first.version.id);
    expect(second.job!.id).toBe(first.job!.id);
    expect(await counts()).toEqual(before);
  });

  it('returns the current job state when an already-processed upload is re-submitted', async () => {
    const bytes = enc('processed already');
    await submit(bytes, 'a.txt');
    await processNext();
    const again = await submit(bytes, 'a.txt');
    expect(again.deduplicated).toBe(true);
    expect(again.job!.status).toBe('COMPLETED');
  });

  it('collapses concurrent identical uploads into one document, version and job', async () => {
    const bytes = enc('race condition content');
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(bytes, 'race.txt')));
    expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(await counts()).toMatchObject({ documents: 1, versions: 1, jobs: 1 });
  });

  it('keeps identical bytes under different sources separate while sharing one stored blob', async () => {
    const other = await insertSource(db);
    const bytes = enc('shared bytes');
    const a = await submit(bytes, 'a.txt');
    const b = await submit(bytes, 'a.txt', { sourceId: other.id });
    expect(b.deduplicated).toBe(false);
    expect(b.document.id).not.toBe(a.document.id);
    const versions = await db.select().from(documentVersions);
    expect(new Set(versions.map((v) => v.storageKey)).size).toBe(1);
    expect(blobFileCount()).toBe(1);
  });

  it('adds a new version to an existing document', async () => {
    const v1 = await submit(enc('version one'), 'doc.txt');
    const v2 = await submit(enc('version two, different'), 'doc.txt', { documentId: v1.document.id });
    expect(v2.deduplicated).toBe(false);
    expect(v2.document.id).toBe(v1.document.id);
    expect(v2.version.versionNumber).toBe(2);
    const details = await getDocumentDetails(db, v1.document.id);
    expect(details.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(details.latestVersion.id).toBe(v2.version.id);
  });

  it('rejects documentId for another source or an unknown document', async () => {
    const other = await insertSource(db);
    const mine = await submit(enc('mine'), 'a.txt');
    await expect(submit(enc('x1'), 'b.txt', { sourceId: other.id, documentId: mine.document.id })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(submit(enc('x2'), 'b.txt', { documentId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('refuses a source that does not permit indexing and stores nothing', async () => {
    const locked = await insertSource(db, { licenseKind: 'proprietary', allowIndexing: false, allowQuotation: false, allowRedistribution: false });
    await expect(submit(enc('secret'), 'a.txt', { sourceId: locked.id })).rejects.toMatchObject({ code: 'INDEXING_NOT_PERMITTED', httpStatus: 403 });
    expect(await counts()).toMatchObject({ documents: 0, versions: 0, jobs: 0 });
    expect(blobFileCount()).toBe(0);
  });

  it('verifies a declared source checksum against the upload', async () => {
    const bytes = enc('checksummed');
    const guarded = await insertSource(db, { contentChecksum: sha256Hex(bytes) });
    await expect(submit(enc('tampered'), 'a.txt', { sourceId: guarded.id })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(submit(bytes, 'a.txt', { sourceId: guarded.id })).resolves.toMatchObject({ deduplicated: false });
  });

  it('rejects invalid files before storing anything', async () => {
    await expect(submit(new Uint8Array(0), 'empty.txt')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(submit(enc('x'), 'a.exe')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(submit(Uint8Array.from([0x4d, 0x5a, 0, 0]), 'a.txt')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(submit(new Uint8Array(2_000_000).fill(97), 'big.txt')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await counts()).toMatchObject({ documents: 0, jobs: 0 });
    expect(blobFileCount()).toBe(0);
  });

  it('requires a title when there is no filename to derive one from', async () => {
    await expect(
      submitDocument({ db, blobs: blobs.store, maxUploadBytes: 1e6 }, { sourceId: source.id, file: { bytes: enc('x'), filename: null, declaredType: 'text/plain' } }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
  });
});

describe('processing', () => {
  it('ingests TXT end to end: extract, chunk, store, complete', async () => {
    const submitted = await submit(enc(longText('t')), 'book.txt');
    const { job, outcome } = await processNext();
    expect(outcome).toMatchObject({ status: 'COMPLETED' });
    expect(job.id).toBe(submitted.job!.id);

    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.latestJob).toMatchObject({ status: 'COMPLETED', stage: 'store', error: null });
    expect(details.latestJob!.finishedAt).not.toBeNull();
    expect(details.chunkCount).toBeGreaterThan(1);
    expect(details.latestVersion.extraction).toMatchObject({ status: 'ok', method: 'txt-paragraphs@1.0.0' });
    expect(details.latestVersion.chunking).toMatchObject({ chunkerVersion: 'structural-v1', targetTokens: 350 });

    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceId: source.id,
        documentId: submitted.document.id,
        documentVersionId: submitted.version.id,
        extractionMethod: 'txt-paragraphs@1.0.0',
        chunkerVersion: 'structural-v1',
        offsetBasis: 'document_text',
      });
      expect(row.charStart).not.toBeNull();
      expect(row.chunkingConfigHash).toMatch(/^[0-9a-f]{16}$/);
      expect(row.contentSha256).toBe(sha256Hex(row.content));
      expect(row.locator).toMatchObject({ kind: 'text_range' });
    }
  });

  it('ingests Markdown with heading context and upgrades a filename-derived title', async () => {
    const md = `# The Real Title\n\nIntro.\n\n## Part One\n\n${longText('m', 3)}\n\n## Part Two\n\nTail text.\n`;
    const submitted = await submit(enc(md), 'upload-1234.md');
    expect(submitted.document.titleOrigin).toBe('filename');
    await processNext();
    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.document).toMatchObject({ title: 'The Real Title', titleOrigin: 'extracted' });
    expect(details.latestVersion.extractedTitle).toBe('The Real Title');
    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(rows[0]).toMatchObject({ headingPath: ['The Real Title'], sectionId: '1' });
    expect(rows.some((r) => r.headingPath.join('/') === 'The Real Title/Part One')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ headingPath: ['The Real Title', 'Part Two'], sectionId: '1.2' });
  });

  it('does not overwrite a declared title with an extracted one', async () => {
    const submitted = await submit(enc('# Extracted\n\nbody text'), 'a.md', { title: 'Declared' });
    await processNext();
    expect((await getDocumentDetails(db, submitted.document.id)).document).toMatchObject({ title: 'Declared', titleOrigin: 'declared' });
  });

  it('ingests a PDF with page attribution, metadata and an empty-page warning', async () => {
    const pdf = buildPdf(
      [
        { lines: [{ text: 'Opening', size: 20 }, { text: 'Text on the first page of the PDF.' }] },
        { lines: [] },
        { lines: [{ text: 'Text after the blank page.' }] },
      ],
      { title: 'Embedded PDF Title' },
    );
    const submitted = await submit(pdf, 'scan-0001.pdf');
    const { outcome } = await processNext();
    expect(outcome).toMatchObject({ status: 'COMPLETED' });

    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.latestVersion).toMatchObject({ pageCount: 3, extractedTitle: 'Embedded PDF Title', mimeType: 'application/pdf' });
    expect(details.document.title).toBe('Embedded PDF Title');
    expect(details.latestVersion.extraction?.warnings.map((w) => w.code)).toEqual(['EMPTY_PAGES']);
    expect(details.latestVersion.extraction?.pages).toMatchObject({ total: 3, text: 2, blank: [2], imageOnly: [] });

    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(rows.map((r) => [r.pageStart, r.pageEnd])).toEqual([[1, 3]]);
    expect(rows[0]).toMatchObject({ offsetBasis: 'page_text', headingPath: ['Opening'], extractionMethod: expect.stringMatching(/^pdf-text@1\.0\.0\+pdfjs-/) });
    expect(rows[0]!.locator).toEqual({ kind: 'page_range', pageStart: 1, pageEnd: 3 });
  });

  it('stores a chunk that begins late on one PDF page and ends early on the next', async () => {
    const longLine = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const pdf = buildPdf([
      { lines: [{ text: longLine }, { text: 'Late on page one.', gapBefore: 30 }] },
      { lines: [{ text: 'Early on page two.' }] },
    ]);
    const submitted = await submit(pdf, 'spanning.pdf');
    const { outcome } = await processNext({ chunking: { targetTokens: 100, maxTokens: 140, overlapTokens: 0 } });
    expect(outcome).toMatchObject({ status: 'COMPLETED' });
    const rows = await db.select().from(chunks).orderBy(asc(chunks.chunkIndex));
    const spanning = rows.find((r) => r.pageStart === 1 && r.pageEnd === 2)!;
    expect(spanning).toBeDefined();
    expect(spanning.charEnd!).toBeLessThan(spanning.charStart!);
    expect(spanning.locator).toEqual({ kind: 'page_range', pageStart: 1, pageEnd: 2 });
    expect((await getDocumentDetails(db, submitted.document.id)).latestJob!.status).toBe('COMPLETED');
  });

  it('reprocessing a completed version creates no duplicate chunks and keeps the same ids', async () => {
    const submitted = await submit(enc(longText('r')), 'a.txt');
    await processNext();
    const before = await db.select({ id: chunks.id }).from(chunks).orderBy(asc(chunks.chunkIndex));
    await db.insert(ingestionJobs).values({ documentVersionId: submitted.version.id, queuedAt: new Date() });
    const { outcome } = await processNext();
    expect(outcome.status).toBe('COMPLETED');
    const after = await db.select({ id: chunks.id }).from(chunks).orderBy(asc(chunks.chunkIndex));
    expect(after).toEqual(before);
  });

  it('keeps versions isolated: chunks of an older version survive and never mix with the newer one', async () => {
    const v1 = await submit(enc(longText('one')), 'doc.txt');
    await processNext();
    const v2 = await submit(enc(longText('two')), 'doc.txt', { documentId: v1.document.id });
    await processNext();

    const v1Rows = await db.select().from(chunks).where(eq(chunks.documentVersionId, v1.version.id));
    const v2Rows = await db.select().from(chunks).where(eq(chunks.documentVersionId, v2.version.id));
    expect(v1Rows.length).toBeGreaterThan(0);
    expect(v2Rows.length).toBeGreaterThan(0);
    expect(v1Rows.every((r) => r.content.includes('one'))).toBe(true);
    expect(v2Rows.every((r) => r.content.includes('two'))).toBe(true);
    expect(new Set([...v1Rows, ...v2Rows].map((r) => r.id)).size).toBe(v1Rows.length + v2Rows.length);
    expect((await getDocumentDetails(db, v1.document.id)).chunkCount).toBe(v2Rows.length);
  });

  it('skips a job that is not PROCESSING', async () => {
    const submitted = await submit(enc('abc def'), 'a.txt');
    expect(await processJob(deps(), submitted.job!.id)).toMatchObject({ status: 'SKIPPED' });
    expect(await processJob(deps(), '00000000-0000-4000-8000-000000000000')).toMatchObject({ status: 'SKIPPED' });
  });
});

describe('failures are visible and recoverable', () => {
  it('fails a scanned PDF with OCR_REQUIRED, stores no chunks, and never reports completion', async () => {
    const submitted = await submit(buildPdf([{ image: true }, { image: true }]), 'scanned.pdf');
    const { outcome } = await processNext();
    expect(outcome).toEqual({ status: 'FAILED', errorCode: 'OCR_REQUIRED' });

    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.latestJob).toMatchObject({ status: 'FAILED', stage: 'extract', error: { code: 'OCR_REQUIRED' } });
    expect(details.latestJob!.error!.message).toMatch(/OCR/);
    expect(details.latestJob!.error!.details).toMatchObject({ imageOnlyPages: [1, 2] });
    expect(details.latestVersion.extraction).toMatchObject({ status: 'failed' });
    expect(details.chunkCount).toBe(0);
  });

  it.each([
    ['encrypted', () => buildPdf([{ lines: [{ text: 'secret' }] }], { userPassword: 'pw' }), 'ENCRYPTED_PDF'],
    ['truncated', () => truncatePdf(buildPdf([{ lines: [{ text: 'text' }] }]), 0.3), 'MALFORMED_DOCUMENT'],
    ['blank', () => buildPdf([{ lines: [] }]), 'NO_EXTRACTABLE_TEXT'],
  ])('records %s PDFs as FAILED with %s', async (_label, make, code) => {
    await submit(make(), 'x.pdf');
    expect((await processNext()).outcome).toEqual({ status: 'FAILED', errorCode: code });
  });

  it('fails documents with headings but no body text (NO_CHUNKS)', async () => {
    await submit(enc('# Only\n\n## Headings\n'), 'a.md');
    expect((await processNext()).outcome).toEqual({ status: 'FAILED', errorCode: 'NO_CHUNKS' });
  });

  it('retries a failed extraction as a NEW job, keeping the failed job as history', async () => {
    const submitted = await submit(buildPdf([{ image: true }]), 'scanned.pdf');
    await processNext();
    const retry = await retryDocument(db, submitted.document.id);
    expect(retry).toMatchObject({ status: 'PENDING' });
    const jobs = await db.select().from(ingestionJobs).orderBy(asc(ingestionJobs.createdAt));
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.retryOfJobId).toBe(jobs[0]!.id);
    expect(jobs[0]!.status).toBe('FAILED');

    expect((await processNext()).outcome).toEqual({ status: 'FAILED', errorCode: 'OCR_REQUIRED' });
    expect((await db.select().from(ingestionJobs)).filter((j) => j.status === 'FAILED')).toHaveLength(2);
  });

  it('recovers from a transient infrastructure failure: missing blob, then restored, then retried', async () => {
    const bytes = enc(longText('rec'));
    const submitted = await submit(bytes, 'a.txt');
    const [version] = await db.select().from(documentVersions);
    await rm(join(blobs.dir, version!.storageKey));

    expect((await processNext()).outcome).toEqual({ status: 'FAILED', errorCode: 'BLOB_MISSING' });
    expect((await getDocumentDetails(db, submitted.document.id)).chunkCount).toBe(0);

    await blobs.store.put(bytes); // the blob is back
    await retryDocument(db, submitted.document.id);
    expect((await processNext()).outcome).toMatchObject({ status: 'COMPLETED' });

    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.latestJob).toMatchObject({ status: 'COMPLETED', error: null });
    expect(details.chunkCount).toBeGreaterThan(0);
  });

  it('detects a tampered blob', async () => {
    await submit(enc('integrity matters'), 'a.txt');
    const [version] = await db.select().from(documentVersions);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(blobs.dir, version!.storageKey), 'tampered!');
    expect((await processNext()).outcome).toEqual({ status: 'FAILED', errorCode: 'BLOB_INTEGRITY_ERROR' });
  });

  it('does not report completion when chunk persistence fails, and leaves no partial state', async () => {
    const submitted = await submit(enc(longText('p')), 'a.txt');
    const brokenChunker: ProcessDeps['chunk'] = (doc, context, cfg, counter) => {
      const drafts = chunkDocumentForTest(doc, context, cfg, counter);
      return drafts.map((d, i) => (i === drafts.length - 1 ? { ...d, content: '   ' } : d)); // violates chunks_content_not_blank
    };
    const { outcome } = await processNext({ chunk: brokenChunker });
    expect(outcome).toEqual({ status: 'FAILED', errorCode: 'CHUNK_PERSISTENCE_FAILED' });

    const details = await getDocumentDetails(db, submitted.document.id);
    expect(details.latestJob).toMatchObject({ status: 'FAILED', stage: 'store', error: { code: 'CHUNK_PERSISTENCE_FAILED' } });
    // the stored message names the violated constraint but never embeds SQL or document text
    const message = details.latestJob!.error!.message;
    expect(message).toMatch(/chunks_content_not_blank/);
    expect(message).not.toMatch(/insert into|values \(|Failed query|params/i);
    expect(message).not.toContain('p0x0');
    expect(details.chunkCount).toBe(0); // the transaction rolled back every earlier chunk
    expect(details.latestVersion.extraction).toBeNull(); // and did not claim extraction succeeded
    expect(details.document.titleOrigin).toBe('filename');
  });

  it('discards its result when the job was taken away mid-run (stale recovery), writing nothing', async () => {
    const submitted = await submit(enc(longText('lost')), 'a.txt');
    const real = blobs.store;
    const hijacking: BlobStore = {
      put: (b) => real.put(b),
      exists: (k) => real.exists(k),
      get: async (key) => {
        await db.update(ingestionJobs).set({ status: 'PENDING', stage: null, heartbeatAt: null }).where(eq(ingestionJobs.documentVersionId, submitted.version.id));
        return real.get(key);
      },
    };
    const { outcome } = await processNext({ blobs: hijacking });
    expect(outcome.status).toBe('SKIPPED');
    expect((await counts()).chunks).toBe(0);
    expect((await db.select().from(ingestionJobs))[0]!.status).toBe('PENDING');
  });

  it('enforces retry rules', async () => {
    await expect(retryDocument(db, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    const submitted = await submit(buildPdf([{ image: true }]), 'scanned.pdf');
    await expect(retryDocument(db, submitted.document.id)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' }); // still PENDING
    await processNext();
    await retryDocument(db, submitted.document.id);
    await expect(retryDocument(db, submitted.document.id)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' }); // retry already queued

    const ok = await submit(enc('fine text here'), 'ok.txt');
    await processNext(); // claims the older PENDING retry job first: FIFO
    await processNext();
    await expect(retryDocument(db, ok.document.id)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' }); // COMPLETED
  });
});

describe('job queue', () => {
  it('lets concurrent workers claim distinct jobs, never the same one twice', async () => {
    for (let i = 0; i < 6; i++) await submit(enc(`document number ${i} with some text`), `d${i}.txt`);
    const claimed = await Promise.all(Array.from({ length: 6 }, () => claimNextJob(db)));
    const ids = claimed.map((j) => j?.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(6);
    expect(claimed.every((j) => j!.status === 'PROCESSING' && j!.attempt === 1 && j!.startedAt && j!.heartbeatAt)).toBe(true);
    expect(await claimNextJob(db)).toBeNull();
  });

  it('claims the oldest pending job first', async () => {
    const first = await submit(enc('first doc'), 'a.txt');
    await submit(enc('second doc'), 'b.txt');
    expect((await claimNextJob(db))!.id).toBe(first.job!.id);
  });

  it('recovers jobs abandoned by a dead worker: re-queue, or fail with WORKER_LOST after max attempts', async () => {
    const [a, b, c] = await Promise.all([submit(enc('aaa'), 'a.txt'), submit(enc('bbb'), 'b.txt'), submit(enc('ccc'), 'c.txt')]);
    for (const _ of [a, b, c]) await claimNextJob(db);
    const old = new Date(Date.now() - 10 * 60_000);
    await db.update(ingestionJobs).set({ heartbeatAt: old }).where(eq(ingestionJobs.id, a.job!.id));
    await db.update(ingestionJobs).set({ heartbeatAt: old, attempt: 3 }).where(eq(ingestionJobs.id, b.job!.id));

    const result = await recoverStaleJobs(db, { staleAfterMs: 60_000, maxAttempts: 3 });
    expect(result).toEqual({ requeued: 1, failed: 1 });

    const byId = Object.fromEntries((await db.select().from(ingestionJobs)).map((j) => [j.id, j]));
    expect(byId[a.job!.id]).toMatchObject({ status: 'PENDING', stage: null });
    expect(byId[b.job!.id]).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_LOST' });
    expect(byId[c.job!.id]!.status).toBe('PROCESSING'); // fresh heartbeat: untouched
  });
});

import { chunkDocument as chunkDocumentForTest } from './chunking/chunker';
