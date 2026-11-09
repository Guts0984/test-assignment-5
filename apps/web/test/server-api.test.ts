// @vitest-environment node
import { verifyClientIp } from '@kanban/shared';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from './support/msw';

const SECRET = 'web-test-client-ip-secret-0123456789';
let requestHeaders: Record<string, string> = {};
let cookieValue: string | undefined;

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(requestHeaders)),
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'sid' && cookieValue ? { value: cookieValue } : undefined),
    }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/shared/lib/env.server', () => ({
  serverEnv: () => ({ apiUrl: 'http://api.test', clientIpSecret: SECRET }),
}));

const { apiFetch, loadPrivate, loadPublic } = await import('@/shared/lib/server-api');

let seen: Headers[] = [];
beforeEach(() => {
  seen = [];
  cookieValue = 'a'.repeat(43);
  requestHeaders = { 'x-real-ip': '203.0.113.7' };
  server.use(
    http.all('http://api.test/*', ({ request }) => {
      seen.push(new Headers(request.headers));
      return HttpResponse.json({ ok: true });
    }),
  );
});

const claimedIp = async (headers: Headers) =>
  verifyClientIp(
    SECRET,
    headers.get('x-client-ip') ?? undefined,
    headers.get('x-client-ip-signature') ?? undefined,
  );

describe('every server-side call to the API carries the visitor’s signed address', () => {
  it('apiFetch (also used by Server Actions) signs the address nginx put in X-Real-IP, and forwards the session', async () => {
    await apiFetch('/workspaces');
    expect(await claimedIp(seen[0]!)).toBe('203.0.113.7');
    expect(seen[0]!.get('cookie')).toBe(`sid=${'a'.repeat(43)}`);
  });

  it('loadPrivate (page loaders) signs it', async () => {
    await loadPrivate('/me');
    expect(await claimedIp(seen[0]!)).toBe('203.0.113.7');
  });

  it('loadPublic (the invitation page, no session) still signs it, but sends no cookie', async () => {
    await loadPublic('/invites/abc');
    expect(await claimedIp(seen[0]!)).toBe('203.0.113.7');
    expect(seen[0]!.get('cookie')).toBeNull();
  });

  it('gives each visitor their own address: two visitors never share one', async () => {
    await apiFetch('/me');
    requestHeaders = { 'x-real-ip': '198.51.100.9' };
    await apiFetch('/me');
    expect(await claimedIp(seen[0]!)).toBe('203.0.113.7');
    expect(await claimedIp(seen[1]!)).toBe('198.51.100.9');
  });

  it('never takes the address from anything a browser can set except through nginx’s X-Real-IP', async () => {
    requestHeaders = {
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '1.1.1.1',
      'x-client-ip': '2.2.2.2',
      'x-client-ip-signature': 'forged',
    };
    await apiFetch('/me');
    expect(await claimedIp(seen[0]!)).toBe('203.0.113.7');
    expect(seen[0]!.get('x-forwarded-for')).toBeNull(); // not passed on either
  });

  it('sends no claim (rather than a made-up one) when nginx gave no usable address', async () => {
    const unusable: Record<string, string>[] = [
      {},
      { 'x-real-ip': 'not-an-ip' },
      { 'x-real-ip': '203.0.113.7, 198.51.100.1' },
    ];
    for (const headers of unusable) {
      requestHeaders = headers;
      seen = [];
      await apiFetch('/me');
      expect(seen[0]!.get('x-client-ip')).toBeNull();
      expect(seen[0]!.get('x-client-ip-signature')).toBeNull();
    }
  });
});

describe('answers', () => {
  it('sends a visitor without a valid session to the login page, and a missing resource to 404', async () => {
    server.use(
      http.get('http://api.test/private', () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 }),
      ),
    );
    server.use(
      http.get('http://api.test/missing', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'x' } }, { status: 404 }),
      ),
    );
    await expect(loadPrivate('/private')).rejects.toThrow('REDIRECT /login');
    await expect(loadPrivate('/missing')).rejects.toThrow('NOT_FOUND');
    expect(await loadPublic('/missing')).toBeNull();
  });
});

describe('the rule behind it', () => {
  it('only the two API clients call fetch (a second place could forget the address)', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) =>
      readdirSync(dir).forEach((name) =>
        statSync(join(dir, name)).isDirectory()
          ? walk(join(dir, name))
          : /\.(ts|tsx)$/.test(name) && files.push(join(dir, name)),
      );
    walk(root);
    const callers = files
      .filter((file) => /[^.\w]fetch\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(callers.sort()).toEqual(['shared/lib/client-api.ts', 'shared/lib/server-api.ts']);
  });
});
