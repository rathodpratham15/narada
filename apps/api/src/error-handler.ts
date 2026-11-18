import { AppError } from '@narada/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  const body: ErrorEnvelope = {
    error: { code, message, requestId: request.id, ...(details ? { details } : {}) },
  };
  return reply.code(status).send(body);
}

/** One place that turns every failure into the documented error envelope. Internals are logged, never returned. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    send(reply, request, 404, 'NOT_FOUND', `Route ${request.method} ${request.url.split('?')[0]} does not exist.`),
  );

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.httpStatus >= 500) request.log.error({ err: error }, error.message);
      return send(reply, request, error.httpStatus, error.code, error.message, error.details);
    }

    if (error instanceof ZodError) {
      return send(reply, request, 400, 'VALIDATION_ERROR', 'Request validation failed.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    if ((error as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE') {
      return send(reply, request, 413, 'FILE_TOO_LARGE', 'The uploaded file exceeds the maximum upload size.');
    }

    const statusCode = (error as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      // Framework-level client errors (malformed JSON, unsupported media type, body too large, …).
      return send(reply, request, statusCode, 'BAD_REQUEST', error.message);
    }

    request.log.error({ err: error }, 'Unhandled error');
    return send(reply, request, 500, 'INTERNAL_ERROR', 'An internal error occurred.');
  });
}
