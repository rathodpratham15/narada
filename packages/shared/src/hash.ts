import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
