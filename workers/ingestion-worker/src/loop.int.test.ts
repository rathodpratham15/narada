import { createTempBlobStore, createTestDatabase, insertSource, resetDatabase } from '@narada/test-utils';
import { documentVersions, ingestionJobs } from '@narada/database';
import { submitDocument } from '@narada/ingestion';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerLoop } from './loop';

const handle = createTestDatabase();
const { db } = handle;
const blobs = createTempBlobStore();
const options = { pollIntervalMs: 10, staleJobMs: 60_000, maxAttempts: 3 };

beforeEach(() => resetDatabase(db));
afterAll(async () => {
  await handle.close();
  blobs.cleanup();
});

async function enqueue(text: string) {
  const source = await insertSource(db);
  return submitDocument(
    { db, blobs: blobs.store, maxUploadBytes: 1e6 },
    { sourceId: source.id, file: { bytes: new TextEncoder().encode(text), filename: 'a.txt', declaredType: null } },
  );
}

async function waitForStatus(jobId: string, status: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [job] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, jobId));
    if (job?.status === status) return job;
    if (Date.now() > deadline) throw new Error(`job stayed ${job?.status}, wanted ${status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('worker loop lifecycle', () => {
  it('can be started again after being stopped', async () => {
    const worker = createWorkerLoop(db, { db, blobs: blobs.store }, options);
    worker.start();
    await worker.stop();

    const submitted = await enqueue('processed after a restart');
    worker.start();
    await waitForStatus(submitted.job!.id, 'COMPLETED');
    await worker.stop();
  });

  it('ignores a second start() instead of running two pollers', async () => {
    const worker = createWorkerLoop(db, { db, blobs: blobs.store }, options);
    worker.start();
    worker.start();
    const submitted = await enqueue('only processed once');
    const job = await waitForStatus(submitted.job!.id, 'COMPLETED');
    expect(job.attempt).toBe(1);
    await worker.stop();
  });

  it('stop() waits for the in-flight job instead of abandoning it', async () => {
    const worker = createWorkerLoop(db, { db, blobs: blobs.store }, options);
    const submitted = await enqueue('x '.repeat(5000));
    worker.start();
    await waitForStatus(submitted.job!.id, 'PROCESSING').catch(() => undefined); // may already be done: both are fine
    await worker.stop();
    const [job] = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, submitted.job!.id));
    expect(['COMPLETED', 'FAILED']).toContain(job!.status); // never left half-way in PROCESSING
  });

  it('does nothing and returns null when the queue is empty', async () => {
    const worker = createWorkerLoop(db, { db, blobs: blobs.store }, options);
    expect(await worker.runOnce()).toBeNull();
    expect((await db.select({ n: count() }).from(documentVersions))[0]!.n).toBe(0);
  });
});
