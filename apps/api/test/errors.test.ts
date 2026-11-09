import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';

let api: RunningApp;

beforeAll(async () => {
  api = await startApp(testConfig());
});

afterAll(async () => {
  await api.close();
});

const post = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(`${api.url}${path}`, { method: 'POST', ...init });

describe('bad input is always a 4xx in the one error shape', () => {
  it('malformed JSON', async () => {
    const response = await post('/t/echo', {
      headers: { 'content-type': 'application/json' },
      body: '{"title": "x", ',
    });
    expectError(response, 400, 'validation_failed');
  });

  it('a body that is not an object, or no body, or the wrong content type', async () => {
    expectError(await post('/t/echo', { json: ['not', 'an', 'object'] }), 400, 'validation_failed');
    expectError(await post('/t/echo'), 400, 'validation_failed');
    expectError(
      await post('/t/echo', { headers: { 'content-type': 'text/plain' }, body: 'title=x' }),
      400,
      'validation_failed',
    );
  });

  it('reports every invalid field with its path', async () => {
    const error = expectError(
      await post('/t/echo', { json: { title: '', n: 'x' } }),
      400,
      'validation_failed',
    );
    const issues = (error.details?.issues ?? []) as { path: string }[];
    expect(issues.map((issue) => issue.path).sort()).toEqual(['n', 'title']);
  });

  it('a NUL byte inside a JSON string (PostgreSQL would answer 500)', async () => {
    const error = expectError(
      await post('/t/echo', { json: { title: 'a\u0000b', n: 1 } }),
      400,
      'validation_failed',
    );
    expect(JSON.stringify(error.details)).toContain('title');
  });

  it('a body over the 1 MB limit', async () => {
    const response = await post('/t/echo', { json: { title: 'x'.repeat(2 * 1024 * 1024), n: 1 } });
    expectError(response, 413, 'payload_too_large');
  });

  it('broken percent-encoding in a path parameter', async () => {
    expectError(await call(`${api.url}/t/param/%E0%A4%A`), 400, 'validation_failed');
  });

  it('an unknown route or method', async () => {
    expectError(await call(`${api.url}/nope`), 404, 'not_found');
    expectError(await call(`${api.url}/health`, { method: 'DELETE' }), 404, 'not_found');
  });
});

describe('database errors caused by data never become a 500', () => {
  it('NUL byte reaching PostgreSQL', async () => {
    expectError(await call(`${api.url}/t/pg-nul`), 400, 'validation_failed');
  });

  it('a CHECK constraint violation', async () => {
    expectError(await call(`${api.url}/t/pg-check`), 400, 'validation_failed');
  });
});

describe('server faults', () => {
  it('are a 500 that reveals nothing, but can be traced by request id', async () => {
    const response = await call(`${api.url}/t/boom`);
    const error = expectError(response, 500, 'internal_error');
    const raw = JSON.stringify(response.body);
    for (const secret of ['secret', 'passwd', 'hunter2', 'Error:', 'at '])
      expect(raw).not.toContain(secret);
    expect(error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('application errors keep their code, message and details', async () => {
    const error = expectError(await call(`${api.url}/t/app-error`), 403, 'forbidden');
    expect(error).toMatchObject({ message: 'Viewers cannot do this', details: { why: 'role' } });
  });
});

describe('request ids', () => {
  it('keeps a well-formed id and replaces a hostile one', async () => {
    const kept = await call(`${api.url}/health`, { headers: { 'x-request-id': 'trace-12345678' } });
    expect(kept.headers.get('x-request-id')).toBe('trace-12345678');

    for (const hostile of [
      'short',
      'has spaces in it',
      'x'.repeat(65),
      '<script>alert(1)</script>',
    ]) {
      const replaced = await call(`${api.url}/health`, { headers: { 'x-request-id': hostile } });
      expect(replaced.headers.get('x-request-id')).not.toBe(hostile);
      expect(replaced.headers.get('x-request-id')).toMatch(/^[\w.-]{8,64}$/);
    }
  });
});

describe('API documentation', () => {
  it('serves Swagger UI and an OpenAPI document that lists the endpoints', async () => {
    const ui = await call(`${api.url}/docs`);
    expect(ui.status).toBe(200);
    expect(String(ui.body)).toContain('swagger');

    const spec = await call(`${api.url}/docs-json`);
    expect(spec.status).toBe(200);
    const document = spec.body as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    // Every endpoint of the assignment's table (plus the few the UI needs) is documented.
    expect(documented).toEqual(
      expect.arrayContaining([
        'POST /auth/register',
        'POST /auth/login',
        'POST /auth/logout',
        'GET /me',
        'GET /workspaces',
        'POST /workspaces/{id}/invites',
        'POST /invites/{token}/accept',
        'PATCH /workspaces/{id}/members/{userId}',
        'DELETE /workspaces/{id}/members/{userId}',
        'GET /boards/{id}',
        'POST /boards/{id}/cards',
        'PATCH /cards/{id}',
        'DELETE /cards/{id}',
        'POST /cards/{id}/move',
        'GET /cards/{id}/comments',
        'POST /cards/{id}/comments',
        'POST /cards/{id}/attachments',
        'POST /attachments/{id}/complete',
        'GET /search',
        'GET /boards/{id}/activity',
        'GET /health',
        'GET /ready',
      ]),
    );
    // Request bodies are described by the same schemas that validate them.
    expect(document.paths['/cards/{id}/move']?.post?.requestBody).toBeDefined();
    expect(JSON.stringify(document.paths['/auth/register']?.post?.requestBody)).toContain(
      'password',
    );
  });
});
