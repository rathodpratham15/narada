import { sha256Hex } from '@narada/shared';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BlobCorruptedError, BlobNotFoundError } from './blob-store';
import { LocalBlobStore } from './local-blob-store';

const dir = mkdtempSync(join(tmpdir(), 'narada-blob-test-'));
const store = new LocalBlobStore(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bytes = (s: string) => new TextEncoder().encode(s);

describe('LocalBlobStore', () => {
  it('stores bytes under a content address and returns them unchanged', async () => {
    const data = bytes('original ✓ bytes \u0000 with a NUL');
    const put = await store.put(data);
    expect(put).toMatchObject({ sha256: sha256Hex(data), byteSize: data.length, created: true });
    expect(put.key).toBe(`sha256/${put.sha256.slice(0, 2)}/${put.sha256}`);
    expect(Array.from(await store.get(put.key))).toEqual(Array.from(data));
  });

  it('is idempotent: storing identical bytes again creates nothing new', async () => {
    const first = await store.put(bytes('same'));
    const second = await store.put(bytes('same'));
    expect(second.key).toBe(first.key);
    expect(second.created).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    await store.put(bytes('tidy'));
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('throws BlobNotFoundError for a key that was never stored', async () => {
    await expect(store.get(`sha256/ab/${'ab'.repeat(32)}`)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('detects tampering: stored bytes that no longer match their address', async () => {
    const put = await store.put(bytes('will be tampered'));
    writeFileSync(join(dir, put.key), 'different');
    await expect(store.get(put.key)).rejects.toBeInstanceOf(BlobCorruptedError);
  });

  it('refuses keys that are not content addresses (no path traversal)', async () => {
    for (const key of ['../../etc/passwd', 'sha256/../x', '/etc/passwd', `sha256/ab/${'g'.repeat(64)}`, 'sha256/ab/short']) {
      await expect(store.get(key), key).rejects.toThrow(/Invalid blob key/);
      await expect(store.exists(key), key).rejects.toThrow(/Invalid blob key/);
    }
  });
});
