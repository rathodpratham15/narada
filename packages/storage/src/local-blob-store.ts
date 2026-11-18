import { sha256Hex } from '@narada/shared';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BlobCorruptedError, BlobNotFoundError, type BlobStore, type PutResult } from './blob-store';

const KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  static keyFor(sha256: string): string {
    return `sha256/${sha256.slice(0, 2)}/${sha256}`;
  }

  /** Only keys that match the strict content-address pattern are ever turned into paths. */
  private pathFor(key: string): { path: string; sha256: string } {
    const match = KEY_PATTERN.exec(key);
    if (!match) throw new Error(`Invalid blob key: ${JSON.stringify(key).slice(0, 80)}`);
    return { path: join(this.root, 'sha256', match[1]!, match[2]!), sha256: match[2]! };
  }

  async put(bytes: Uint8Array): Promise<PutResult> {
    const sha256 = sha256Hex(bytes);
    const key = LocalBlobStore.keyFor(sha256);
    const { path } = this.pathFor(key);

    const existing = await stat(path).catch(() => null);
    if (existing && existing.size === bytes.length) {
      return { key, sha256, byteSize: bytes.length, created: false };
    }

    await mkdir(dirname(path), { recursive: true });
    // Write to a temp file then rename: readers never observe a partial blob, and a crash leaves no corrupt key.
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    return { key, sha256, byteSize: bytes.length, created: true };
  }

  async get(key: string): Promise<Uint8Array> {
    const { path, sha256 } = this.pathFor(key);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(key);
      throw error;
    }
    if (sha256Hex(data) !== sha256) throw new BlobCorruptedError(key);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async exists(key: string): Promise<boolean> {
    const { path } = this.pathFor(key);
    return (await stat(path).catch(() => null)) !== null;
  }
}
