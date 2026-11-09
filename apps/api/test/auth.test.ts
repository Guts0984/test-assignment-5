import { hashPassword, verifyPassword, users } from '@kanban/db';
import { meSchema } from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import { as, PASSWORD, registerUser, testDb } from './support/world';

let api: RunningApp;
let redis: Redis;

beforeAll(async () => {
  api = await startApp(testConfig());
  const { host, port, password } = inject('infra').redis;
  redis = new Redis({ host, port, password });
});

afterAll(async () => {
  await api.close();
  redis.disconnect();
});

const post = (path: string, json: unknown, headers: Record<string, string> = {}) =>
  call(`${api.url}${path}`, { method: 'POST', json, headers });

const credentials = () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    email: `a-${suffix}@example.com`,
    handle: `h${suffix}`,
    name: 'Alice',
    password: PASSWORD,
  };
};

describe('registration', () => {
  it('creates the account, signs in, and sets a locked-down session cookie', async () => {
    const body = credentials();
    const response = await post('/auth/register', body);

    expect(response.status).toBe(201);
    expect(meSchema.parse(response.body)).toMatchObject({ email: body.email, handle: body.handle });
    expect(JSON.stringify(response.body)).not.toMatch(/password|hash/i);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(cookie).not.toContain('Secure'); // plain http in tests; config.session.cookieSecure turns it on

    const me = await call(`${api.url}/me`, as({ cookie: cookie.split(';')[0]! }));
    expect(me).toMatchObject({ status: 200, body: { email: body.email } });
  });

  it('stores only a hash of the password', async () => {
    const body = credentials();
    await post('/auth/register', body);
    const [row] = await testDb().db.select().from(users).where(eq(users.email, body.email));
    expect(row?.passwordHash).toBeDefined();
    expect(row?.passwordHash).not.toContain(body.password);
    expect(await verifyPassword(body.password, row!.passwordHash)).toBe(true);
  });

  it('refuses a taken email (any letter case) or handle with 409 naming the field', async () => {
    const body = credentials();
    await post('/auth/register', body);

    const sameEmail = await post('/auth/register', {
      ...credentials(),
      email: body.email.toUpperCase(),
    });
    expect(expectError(sameEmail, 409, 'conflict').details).toEqual({ field: 'email' });

    const sameHandle = await post('/auth/register', {
      ...credentials(),
      handle: body.handle.toUpperCase(),
    });
    expect(expectError(sameHandle, 409, 'conflict').details).toEqual({ field: 'handle' });
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['an invalid email', { email: 'not-an-email' }],
    ['an invalid handle', { handle: 'x' }],
    ['a NUL byte in the name', { name: 'Al\u0000ice' }],
    ['a missing field', { name: undefined }],
  ])('rejects %s with a 400', async (_label, override) => {
    expectError(
      await post('/auth/register', { ...credentials(), ...override }),
      400,
      'validation_failed',
    );
  });

  it('keeps nothing behind when the session cannot be created', async () => {
    const config = testConfig();
    const broken = await startApp({ ...config, redis: { ...config.redis, port: 1 } });
    try {
      const body = credentials();
      const response = await call(`${broken.url}/auth/register`, { method: 'POST', json: body });
      expectError(response, 503, 'service_unavailable');
      const rows = await testDb().db.select().from(users).where(eq(users.email, body.email));
      expect(rows).toHaveLength(0); // so the user can simply try again later
    } finally {
      await broken.close();
    }
  });
});

describe('signing in', () => {
  it('works with the right password and is case-insensitive about the email', async () => {
    const body = credentials();
    await post('/auth/register', body);
    const response = await post('/auth/login', {
      email: body.email.toUpperCase(),
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('sid=');
  });

  it('gives the same answer for a wrong password and an unknown email (no account probing)', async () => {
    const body = credentials();
    await post('/auth/register', body);
    const wrongPassword = await post('/auth/login', {
      email: body.email,
      password: 'wrong-password-1',
    });
    const unknownEmail = await post('/auth/login', {
      email: 'nobody-at-all@example.com',
      password: PASSWORD,
    });

    const a = expectError(wrongPassword, 401, 'unauthorized');
    const b = expectError(unknownEmail, 401, 'unauthorized');
    expect({ ...a, requestId: undefined }).toEqual({ ...b, requestId: undefined });
    expect(wrongPassword.headers.get('set-cookie')).toBeNull();
  });

  it('can log in to an account whose hash was made by hashPassword directly', async () => {
    const body = credentials();
    await testDb()
      .db.insert(users)
      .values({
        email: body.email,
        handle: body.handle,
        name: 'Direct',
        passwordHash: await hashPassword('direct-password-1'),
      });
    expect(
      (await post('/auth/login', { email: body.email, password: 'direct-password-1' })).status,
    ).toBe(200);
  });
});

describe('sessions', () => {
  it('are required, and a missing, unknown or malformed cookie is a 401, never a 500', async () => {
    expectError(await call(`${api.url}/me`), 401, 'unauthorized');
    const valid = 'a'.repeat(43);
    for (const cookie of [
      `sid=${valid}`,
      'sid=',
      'sid=not-a-session',
      `sid=${'x'.repeat(5000)}`,
      'sid=%00%00',
      ';;;sid',
      'garbage',
    ]) {
      expectError(await call(`${api.url}/me`, { headers: { cookie } }), 401, 'unauthorized');
    }
  });

  it('end on the server at logout: the old cookie stops working', async () => {
    const user = await registerUser(api.url, 'logout');
    expect((await call(`${api.url}/me`, as(user))).status).toBe(200);

    const out = await call(`${api.url}/auth/logout`, { method: 'POST', ...as(user) });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/sid=;/);

    expectError(await call(`${api.url}/me`, as(user)), 401, 'unauthorized');
    // Logging out again, or without any session, is harmless.
    expect((await call(`${api.url}/auth/logout`, { method: 'POST' })).status).toBe(204);
  });

  it('expire after a period of inactivity, and every use extends that period', async () => {
    const user = await registerUser(api.url, 'ttl');
    const key = `sess:${user.cookie.slice('sid='.length)}`;
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(3600);

    await redis.expire(key, 30);
    await call(`${api.url}/me`, as(user));
    expect(await redis.ttl(key)).toBeGreaterThan(3000);

    await redis.del(key); // as if it had expired
    expectError(await call(`${api.url}/me`, as(user)), 401, 'unauthorized');
  });

  it('are independent: logging out one device keeps the other signed in', async () => {
    const body = credentials();
    await post('/auth/register', body);
    const cookieOf = async () =>
      (
        (await post('/auth/login', { email: body.email, password: PASSWORD })).headers.get(
          'set-cookie',
        ) ?? ''
      ).split(';')[0]!;
    const laptop = { cookie: await cookieOf() };
    const phone = { cookie: await cookieOf() };
    expect(laptop.cookie).not.toBe(phone.cookie);
    await call(`${api.url}/auth/logout`, { method: 'POST', ...as(laptop) });
    expect((await call(`${api.url}/me`, as(phone))).status).toBe(200);
  });
});

describe('cross-site requests', () => {
  it('refuses writes whose Origin is another site, but not reads or same-origin writes', async () => {
    const user = await registerUser(api.url, 'csrf');
    const evil = { origin: 'https://evil.example' };
    expectError(await post('/auth/logout', {}, { ...evil, cookie: user.cookie }), 403, 'forbidden');
    expectError(await post('/auth/login', credentials(), evil), 403, 'forbidden');
    expect((await call(`${api.url}/me`, as(user, evil))).status).toBe(200); // reads are not state changes
    // Our own origin and calls without Origin (server-side, curl) work.
    expect(
      (await post('/auth/logout', {}, { origin: 'http://localhost:8080', cookie: user.cookie }))
        .status,
    ).toBe(204);
    expect((await post('/auth/logout', {})).status).toBe(204);
  });
});
