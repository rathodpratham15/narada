import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Deterministic UUID (version-5 layout) derived from SHA-256 of the given parts. The same inputs always
 * produce the same id, which makes chunk ids stable across retries and re-runs.
 */
export function deterministicUuid(...parts: string[]): string {
  const bytes = Buffer.from(createHash('sha256').update(parts.join('\u001f')).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
