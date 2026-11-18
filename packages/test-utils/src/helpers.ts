import { LocalBlobStore } from '@narada/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A blob store in a throwaway directory. Call `cleanup()` in afterAll. */
export function createTempBlobStore(): { store: LocalBlobStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'narada-blobs-'));
  return { store: new LocalBlobStore(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface MultipartFile {
  field?: string;
  filename: string;
  contentType?: string;
  bytes: Uint8Array;
}

/** Builds a multipart/form-data body for Fastify's `inject`, with no extra dependencies. */
export function buildMultipart(
  fields: Record<string, string>,
  file?: MultipartFile,
): { payload: Buffer; headers: { 'content-type': string } } {
  const boundary = `----narada-test-${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(file.bytes),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
