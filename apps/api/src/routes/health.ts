import type { Database } from '@narada/database';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const healthRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  // Liveness: the process is up. Must not touch dependencies.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencies are reachable. Redis is added in Milestone 4 when the API starts using it.
  app.get('/health/ready', async (request, reply) => {
    let database: 'up' | 'down' = 'up';
    try {
      await withTimeout(db.execute(sql`select 1`), CHECK_TIMEOUT_MS);
    } catch (error) {
      database = 'down';
      request.log.warn({ err: error }, 'Readiness check: database unavailable');
    }
    const ready = database === 'up';
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable', checks: { database } });
  });
};
