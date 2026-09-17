import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.ts';

/**
 * CORS preflight, per HTTP method the app actually uses.
 *
 * This file exists because of a production bug that nothing else could have
 * caught. `@fastify/cors` with no `methods` option advertises only the
 * CORS-safelisted methods — `GET,HEAD,POST` — so the browser blocked every
 * PATCH and DELETE at the preflight. Dismissing a recommendation, renaming a
 * space or project, and removing a material were all broken in production.
 *
 * It was invisible to every other check: CORS is enforced by the BROWSER, and
 * `app.inject` bypasses the network entirely while Node's `fetch` ignores CORS.
 * The server logged nothing, because the server was never asked.
 *
 * So this asserts the preflight RESPONSE HEADERS rather than any behaviour —
 * those headers are the whole contract with the browser. See D-058.
 */

const ALLOWED_ORIGIN = 'http://localhost:5173';

/** Every method the frontend issues. Adding a route with a new verb should add a line here. */
const METHODS_IN_USE = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

describe('CORS preflight', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  const preflight = (method: string, url = '/api/spaces') =>
    app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });

  it.each(METHODS_IN_USE)('permits %s from an allowed origin', async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBeLessThan(400);

    const allowed = (res.headers['access-control-allow-methods'] as string | undefined) ?? '';
    expect(
      allowed.split(',').map((m) => m.trim().toUpperCase()),
      `access-control-allow-methods was "${allowed}" — the browser will block ${method}`,
    ).toContain(method);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('allows the headers every authenticated request sends', async () => {
    const res = await preflight('POST');
    const allowed = ((res.headers['access-control-allow-headers'] as string) ?? '').toLowerCase();
    // Without these the browser blocks the request before it is sent, and the
    // failure looks like the server being unreachable.
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
  });

  it('does not echo an arbitrary origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/spaces',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    const allowOrigin = res.headers['access-control-allow-origin'];
    expect(allowOrigin).not.toBe('https://evil.example.com');
    expect(allowOrigin).not.toBe('*');
  });

  it('covers the specific routes that were broken in production', async () => {
    // Named explicitly so a regression names itself rather than showing up as
    // "a button does nothing".
    const cases = [
      ['PATCH', '/api/recommendations/00000000-0000-0000-0000-000000000000'],
      ['PATCH', '/api/spaces/00000000-0000-0000-0000-000000000000'],
      ['PATCH', '/api/projects/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/materials/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/spaces/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/projects/00000000-0000-0000-0000-000000000000'],
    ] as const;

    for (const [method, url] of cases) {
      const res = await preflight(method, url);
      const allowed = ((res.headers['access-control-allow-methods'] as string) ?? '').toUpperCase();
      expect(allowed, `${method} ${url} would be blocked by the browser`).toContain(method);
    }
  });
});
