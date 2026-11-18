import type { Database } from '@narada/database';
import type { Logger } from '@narada/shared';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerErrorHandling } from './error-handler';
import { healthRoutes } from './routes/health';
import { sourceRoutes } from './routes/sources';

export interface AppDeps {
  db: Database;
  logger: Logger;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's Logger satisfies FastifyBaseLogger; typing it so keeps the app type uniform for plugins.
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Accept a caller-supplied request ID only if it is short and made of safe characters,
    // so it can never be used for log injection.
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      return typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandling(app);

  await app.register(healthRoutes, { db: deps.db });
  await app.register(sourceRoutes, { db: deps.db });

  return app;
}
