import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Loads the repository-root `.env` into `process.env` for local development. Variables that are
 * already set are never overwritten, so real environment configuration always wins. The search stops
 * at the workspace root (the directory holding pnpm-workspace.yaml), so an unrelated `.env` in a
 * parent directory is never picked up. Returns the loaded path, or null when there is none.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) return null;
      process.loadEnvFile(file);
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

export const databaseEnvSchema = z.object({ ...baseShape, ...databaseShape });

export const apiEnvSchema = z.object({
  ...baseShape,
  ...databaseShape,
  REDIS_URL: redisUrl,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type DatabaseConfig = z.infer<typeof databaseEnvSchema>;
export type ApiConfig = z.infer<typeof apiEnvSchema>;

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
