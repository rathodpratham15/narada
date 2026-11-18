import { createDatabase, runMigrations, type Database, type DatabaseHandle } from '@narada/database';
import { sql } from 'drizzle-orm';

export * from './fixtures';
export * from './pdf-builder';
export * from './helpers';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://narada:narada@localhost:5433/narada_test';

/**
 * The integration suite truncates every table, so it refuses to run against anything that does not
 * look like a test database. This protects the development database from `pnpm test`.
 */
export function getTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run integration tests: database "${databaseName}" does not contain "test" in its name. ` +
        'Point TEST_DATABASE_URL at a dedicated test database.',
    );
  }
  return url;
}

export function createTestDatabase(): DatabaseHandle {
  return createDatabase(getTestDatabaseUrl(), { max: 4 });
}

/** Empties every table in the public schema. Migration bookkeeping lives in the `drizzle` schema and is untouched. */
export async function resetDatabase(db: Database): Promise<void> {
  const result = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = result.rows.map((row) => `"public"."${row.tablename}"`);
  if (tables.length > 0) {
    await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
  }
}

/** Vitest globalSetup: verify the test database is reachable and fully migrated. */
export async function setupTestDatabase(): Promise<void> {
  const url = getTestDatabaseUrl();
  const handle = createDatabase(url, { max: 1 });
  try {
    try {
      await handle.db.execute(sql`select 1`);
    } catch (error) {
      throw new Error(
        `Cannot reach the test database. Start the services with "pnpm infra:up" first.\n` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}
