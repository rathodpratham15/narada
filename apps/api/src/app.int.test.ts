import { createLogger } from '@narada/shared';
import { createTestDatabase, resetDatabase } from '@narada/test-utils';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const handle = createTestDatabase();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ db: handle.db, logger: createLogger({ name: 'api-test', level: 'silent' }) });
  await app.ready();
});
beforeEach(() => resetDatabase(handle.db));
afterAll(async () => {
  await app.close();
  await handle.close();
});

const validSource = {
  title: 'Valmiki Ramayana',
  author: 'Valmiki',
  sourceType: 'scripture',
  originalLanguage: 'sa',
  license: { kind: 'public_domain', notes: 'Ancient text; translation by a pre-1930 translator.' },
  permissions: { allowIndexing: true, allowQuotation: true, allowRedistribution: true },
};

describe('health', () => {
  it('GET /health reports liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports database readiness', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'up' } });
  });
});

describe('request IDs', () => {
  it('generates one when the client sends none', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe client-supplied id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-abc_123' } });
    expect(res.headers['x-request-id']).toBe('trace-abc_123');
  });

  it('replaces an unsafe client-supplied id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\nwith newline' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes the request id in error bodies', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'req-404' } });
    expect(res.json().error.requestId).toBe('req-404');
  });
});

describe('POST /v1/sources', () => {
  it('creates a source and returns 201 with the stored record', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/sources', payload: validSource });
    expect(res.statusCode).toBe(201);
    const { source } = res.json();
    expect(source).toMatchObject({
      title: 'Valmiki Ramayana',
      author: 'Valmiki',
      publisher: null,
      edition: null,
      originalLanguage: 'sa',
      permissions: { allowIndexing: true, allowQuotation: true, allowRedistribution: true },
    });
    expect(source.id).toBeTruthy();
  });

  it('returns 400 VALIDATION_ERROR with field paths for invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sources',
      payload: { ...validSource, license: { kind: 'unknown' }, permissions: { allowIndexing: true } },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.requestId).toBeTruthy();
    expect(error.details.issues.map((i: { path: string }) => i.path)).toContain('permissions.allowIndexing');
  });

  it('returns 400 for a missing body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/sources' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sources',
      headers: { 'content-type': 'application/json' },
      payload: '{"title": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('returns 409 SOURCE_ALREADY_EXISTS with the existing id', async () => {
    const first = await app.inject({ method: 'POST', url: '/v1/sources', payload: validSource });
    const second = await app.inject({ method: 'POST', url: '/v1/sources', payload: validSource });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'SOURCE_ALREADY_EXISTS',
      details: { existingSourceId: first.json().source.id },
    });
  });

  it('does not leak internals on unexpected errors', async () => {
    const broken = createTestDatabase();
    await broken.close(); // pool is closed: any query will now fail
    const failing = await buildApp({ db: broken.db, logger: createLogger({ name: 'api-test', level: 'silent' }) });
    const res = await failing.inject({ method: 'POST', url: '/v1/sources', payload: validSource });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.' });
    expect(res.body).not.toMatch(/pool|postgres|ECONN|drizzle/i);
    const ready = await failing.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable', checks: { database: 'down' } });
    await failing.close();
  });
});
