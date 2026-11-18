export interface PutResult {
  /** Content-addressed key, e.g. `sha256/ab/abcd…`. Safe to store in the database. */
  key: string;
  sha256: string;
  byteSize: number;
  /** False when identical content was already stored (writes are idempotent). */
  created: boolean;
}

export class BlobNotFoundError extends Error {
  readonly code = 'BLOB_MISSING';
  constructor(readonly key: string) {
    super(`Blob ${key} does not exist in the blob store.`);
    this.name = 'BlobNotFoundError';
  }
}

export class BlobCorruptedError extends Error {
  readonly code = 'BLOB_INTEGRITY_ERROR';
  constructor(readonly key: string) {
    super(`Blob ${key} failed its integrity check: stored bytes do not match their content address.`);
    this.name = 'BlobCorruptedError';
  }
}

/** Stores the untouched original bytes of every upload (ADR 0003). */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<PutResult>;
  /** Returns the bytes, verifying they still hash to the key. Throws BlobNotFoundError / BlobCorruptedError. */
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}
