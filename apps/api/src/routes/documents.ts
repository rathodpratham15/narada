import type { Database } from '@narada/database';
import { getDocumentDetails, retryDocument, submitDocument, type UploadFile } from '@narada/ingestion';
import { appErrors } from '@narada/shared';
import type { BlobStore } from '@narada/storage';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

export interface DocumentRouteOptions {
  db: Database;
  blobs: BlobStore;
  maxUploadBytes: number;
}

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const formFields = z.strictObject({
  sourceId: z.uuid(),
  title: z.string().trim().min(1).max(1000).optional(),
  language: z.string().trim().regex(BCP47, 'must be a BCP-47 language tag such as "en", "sa" or "hi-Deva"').optional(),
  documentId: z.uuid().optional(),
});

const idParams = z.strictObject({ id: z.uuid() });

export const documentRoutes: FastifyPluginAsync<DocumentRouteOptions> = async (app, options) => {
  const { db, blobs, maxUploadBytes } = options;

  await app.register(multipart, {
    limits: { fileSize: maxUploadBytes, files: 1, fields: 8, fieldSize: 8 * 1024, parts: 10 },
  });

  app.post('/v1/documents', async (request, reply) => {
    if (!request.isMultipart()) {
      throw appErrors.validation('Content-Type must be multipart/form-data with a "file" part.');
    }

    const fields: Record<string, string> = {};
    let file: UploadFile | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw appErrors.validation(`Unexpected file part "${part.fieldname}"; use "file".`);
        if (file) throw appErrors.validation('Only one file may be uploaded per request.');
        // toBuffer() enforces the size limit and throws a 413 that the error handler maps to FILE_TOO_LARGE.
        const buffer = await part.toBuffer();
        file = { bytes: new Uint8Array(buffer), filename: part.filename || null, declaredType: part.mimetype || null };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!file) throw appErrors.validation('A "file" part is required.');
    const input = formFields.parse(fields);

    const result = await submitDocument(
      { db, blobs, maxUploadBytes },
      {
        sourceId: input.sourceId,
        title: input.title ?? null,
        language: input.language ?? null,
        documentId: input.documentId ?? null,
        file,
      },
    );
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  app.get('/v1/documents/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return getDocumentDetails(db, id);
  });

  app.post('/v1/documents/:id/retry', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const job = await retryDocument(db, id);
    return reply.code(202).send({ job });
  });
};
