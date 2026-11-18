import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  max?: number;
  /** Called for errors on idle pooled connections (e.g. server restart). Without a listener pg would crash the process. */
  onPoolError?: (error: Error) => void;
}

export function createDatabase(connectionString: string, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
