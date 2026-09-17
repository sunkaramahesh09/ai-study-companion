import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API client's failure paths.
 *
 * These are the paths a user hits on a bad day and the ones least likely to be
 * exercised by hand, so they are the ones worth pinning: a hung server, an
 * offline client, an expired session, and an endpoint that answers with HTML
 * because the base URL is wrong.
 */

vi.mock('./supabase.ts', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) },
  },
}));

const { api, ApiError, setSessionExpiredHandler } = await import('./api.ts');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api()', () => {
  beforeEach(() => {
    vi.useRealTimers();
    setSessionExpiredHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, value: 42 })));
    await expect(api<{ value: number }>('/api/thing')).resolves.toEqual({ ok: true, value: 42 });
  });

  it('attaches the current access token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/thing');
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer test-token');
  });

  it('does not declare a JSON body on a request that has none', async () => {
    // Fastify rejects `application/json` with an empty body as a 400 from the
    // body parser, before the route or auth runs. Declaring it unconditionally
    // broke every body-less POST: material retry, quiz abandon, the
    // "continue learning" touch, and the next quiz question. See D-060.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/quizzes/abc/next', { method: 'POST' });
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get('content-type')).toBeNull();
    // The token still has to be attached — this must not become a way of
    // sending an unauthenticated request.
    expect(headers.get('authorization')).toBe('Bearer test-token');
  });

  it('does declare a JSON body when there is one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/spaces', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('surfaces the API\'s own message rather than the status line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_request', message: 'Ask a question.' }, 400)));
    await expect(api('/api/tutor/ask')).rejects.toMatchObject({
      status: 400,
      message: 'Ask a question.',
    });
  });

  it('falls back to the status line when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' })),
    );
    await expect(api('/api/thing')).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects a 200 that is not JSON, naming the likely cause', async () => {
    // A misrouted request answered by the frontend host returns index.html
    // with HTTP 200, and parsing that as JSON throws far from the cause.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    await expect(api('/api/thing')).rejects.toThrow(/VITE_API_BASE_URL/);
  });

  it('gives up on a hung request instead of spinning forever', async () => {
    // A server that accepts the connection and goes silent never rejects, so
    // without the abort the spinner never stops and there is no error to act on.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    vi.useFakeTimers();
    const pending = api('/api/thing');
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it('allows an AI endpoint much longer than an ordinary one', async () => {
    // The provider's limiter WAITS rather than failing, so a Tutor answer
    // queued behind others can legitimately take most of a minute before the
    // model is even called. A 30s ceiling would cancel correct requests.
    const seen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    vi.useFakeTimers();
    const pending = api('/api/tutor/ask').catch((e) => {
      seen.push(e.status);
      return null;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(0); // still waiting, correctly
    await vi.advanceTimersByTimeAsync(100_000);
    await pending;
    expect(seen).toEqual([408]);
  });

  it('turns a network failure into something a person can act on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/api/thing')).rejects.toMatchObject({
      status: 0,
      message: expect.stringMatching(/check your connection/i),
    });
  });

  it('reports an expired session exactly once per failed request', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized', message: 'Invalid or expired token.' }, 401)));

    await expect(api('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('does NOT sign the user out on a 403', async () => {
    // 403 means authenticated but not permitted — visiting the admin page
    // without the role must not end the session.
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'forbidden', message: 'Administrator access required.' }, 403)));

    await expect(api('/api/admin/overview')).rejects.toMatchObject({ status: 403 });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('does not sign the user out on a server error', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'boom' }, 500)));

    await expect(api('/api/thing')).rejects.toMatchObject({ status: 500 });
    expect(onExpired).not.toHaveBeenCalled();
  });
});
