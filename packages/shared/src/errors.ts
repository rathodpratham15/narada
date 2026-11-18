/**
 * Application errors carry a stable machine-readable `code` and an HTTP status.
 * Messages are safe to show to clients; internals go in `cause`, which is logged but never serialised.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'NOT_FOUND',
  'INVALID_FILE_TYPE',
  'CHECKSUM_MISMATCH',
  'INDEXING_NOT_PERMITTED',
  'SOURCE_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'SOURCE_ALREADY_EXISTS',
  'RETRY_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'RATE_LIMITED',
  'EMBEDDING_PROVIDER_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options.details;
  }
}

export const appErrors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('VALIDATION_ERROR', message, 400, details ? { details } : {}),

  sourceNotFound: (sourceId: string) =>
    new AppError('SOURCE_NOT_FOUND', `Source ${sourceId} does not exist.`, 404),

  documentNotFound: (documentId: string) =>
    new AppError('DOCUMENT_NOT_FOUND', `Document ${documentId} does not exist.`, 404),

  sourceAlreadyExists: (existingSourceId: string) =>
    new AppError(
      'SOURCE_ALREADY_EXISTS',
      'A source with the same title, author, publisher and edition is already registered.',
      409,
      { details: { existingSourceId } },
    ),

  indexingNotPermitted: (sourceId: string) =>
    new AppError(
      'INDEXING_NOT_PERMITTED',
      `Source ${sourceId} does not permit indexing. Update its licence and permissions with a valid legal basis before ingesting.`,
      403,
      { details: { sourceId } },
    ),

  internal: (cause?: unknown) =>
    new AppError('INTERNAL_ERROR', 'An internal error occurred.', 500, { cause }),
};
