import type { Database } from '@narada/database';
import { createSource, createSourceSchema } from '@narada/source-registry';
import type { FastifyPluginAsync } from 'fastify';

export const sourceRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.post('/v1/sources', async (request, reply) => {
    const input = createSourceSchema.parse(request.body);
    const source = await createSource(db, input);
    return reply.code(201).send({ source });
  });
};
