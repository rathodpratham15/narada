import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Loads the repository-root `.env` into `process.env` for local development. Variables that are
 * already set are never overwritten, so real environment configuration always wins. The search stops
 * at the workspace root (the directory holding pnpm-workspace.yaml), so an unrelated `.env` in a
 * parent directory is never picked up. Returns the loaded path, or null when there is none.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadDotEnv(startDir: string = process.cwd()): string | null {
  const root = findWorkspaceRoot(startDir);
  if (!root) return null;
  const file = join(root, '.env');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

/** Relative paths in configuration resolve against the workspace root, not the (varying) process cwd. */
export function resolveFromWorkspaceRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(findWorkspaceRoot() ?? process.cwd(), path);
}

/**
 * Environment validation. Every process calls one `load*Config` at boot and exits if it throws.
 * Error messages name the offending variables but never echo their values (they may be secrets).
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// or postgresql:// URL');

const redisUrl = z.string().regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL');

const baseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

const databaseShape = {
  DATABASE_URL: postgresUrl,
};

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const blobStoreShape = {
  BLOB_STORE_DIR: z.string().min(1).default('.data/blobs').transform(resolveFromWorkspaceRoot),
};

const extractionShape = {
  MAX_UPLOAD_BYTES: positiveInt(25 * 1024 * 1024),
  PDF_MAX_PAGES: positiveInt(2000),
  EXTRACTION_TIMEOUT_MS: positiveInt(60_000),
  CHUNK_TARGET_TOKENS: positiveInt(350),
  CHUNK_MAX_TOKENS: positiveInt(500),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(60),
};

function refineChunking(
  value: { CHUNK_TARGET_TOKENS: number; CHUNK_MAX_TOKENS: number; CHUNK_OVERLAP_TOKENS: number },
  ctx: z.RefinementCtx,
) {
  if (value.CHUNK_TARGET_TOKENS > value.CHUNK_MAX_TOKENS) {
    ctx.addIssue({ code: 'custom', path: ['CHUNK_TARGET_TOKENS'], message: 'must be <= CHUNK_MAX_TOKENS' });
  }
  if (value.CHUNK_OVERLAP_TOKENS >= value.CHUNK_TARGET_TOKENS) {
    ctx.addIssue({ code: 'custom', path: ['CHUNK_OVERLAP_TOKENS'], message: 'must be < CHUNK_TARGET_TOKENS' });
  }
}

export const databaseEnvSchema = z.object({ ...baseShape, ...databaseShape });

export const apiEnvSchema = z
  .object({
    ...baseShape,
    ...databaseShape,
    ...blobStoreShape,
    ...extractionShape,
    REDIS_URL: redisUrl,
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .superRefine(refineChunking);

export const workerEnvSchema = z
  .object({
    ...baseShape,
    ...databaseShape,
    ...blobStoreShape,
    ...extractionShape,
    WORKER_POLL_INTERVAL_MS: positiveInt(1000),
    WORKER_HEARTBEAT_MS: positiveInt(15_000),
    WORKER_STALE_JOB_MS: positiveInt(120_000),
    WORKER_MAX_ATTEMPTS: positiveInt(3),
  })
  .superRefine(refineChunking);

export type DatabaseConfig = z.infer<typeof databaseEnvSchema>;
export type ApiConfig = z.infer<typeof apiEnvSchema>;
export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export class ConfigError extends Error {
  readonly invalidKeys: string[];

  constructor(invalidKeys: string[], lines: string[]) {
    super(`Invalid environment configuration:\n${lines.map((l) => `  - ${l}`).join('\n')}`);
    this.name = 'ConfigError';
    this.invalidKeys = invalidKeys;
  }
}

function parseEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const keys = new Set<string>();
  const lines = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '(root)');
    keys.add(key);
    return `${key}: ${issue.message}`;
  });
  throw new ConfigError([...keys], lines);
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return parseEnv(databaseEnvSchema, env);
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, env);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return parseEnv(workerEnvSchema, env);
}
