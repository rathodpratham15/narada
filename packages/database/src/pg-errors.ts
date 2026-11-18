export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
  table: string | undefined;
}

/**
 * Finds the underlying PostgreSQL error in an error chain. Drizzle wraps driver errors in a
 * `DrizzleQueryError` whose `cause` is the original `pg` DatabaseError, so we walk `cause`.
 */
export function getPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; table?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = getPgError(error);
  return info?.code === PG_UNIQUE_VIOLATION && (constraint === undefined || info.constraint === constraint);
}
