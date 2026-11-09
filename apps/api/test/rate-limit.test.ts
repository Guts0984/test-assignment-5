import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';

const LIMIT = 5;
let first: RunningApp;
let second: RunningApp;
let redis: Redis;

beforeAll(async () => {
  const config = testConfig({ rateLimit: { perMinute: LIMIT, authPerMinute: 3 } });
  [first, second] = await Promise.all([startApp(config), startApp(config)]);
  const { host, port, password } = inject('infra').redis;
  redis = new Redis({ host, port, password });
});

afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
  redis.disconnect();
});

/** What nginx does: it sets X-Real-IP to the address it accepted the connection from. */
const asClient = (ip: string, extra: Record<string, string> = {}) => ({
  headers: { 'x-real-ip': ip, ...extra },
});
const freshIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

describe('the limit is shared by both API instances', () => {
  it('counts requests across instances and answers the overflow with 429', async () => {
    const ip = freshIp();
    const targets = [first, second];
    for (let i = 0; i < LIMIT; i += 1) {
      const response = await call(`${targets[i % 2]!.url}/t/db`, asClient(ip));
      expect(response.status, `request ${i + 1}`).toBe(200);
      expect(response.headers.get('ratelimit-limit')).toBe(String(LIMIT));
    }
    // One more, on either instance, is over the limit even though each saw only ~half.
    for (const target of targets) {
      const blocked = await call(`${target.url}/t/db`, asClient(ip));
      const error = expectError(blocked, 429, 'rate_limited');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(60);
      expect(error.details?.retryAfterSeconds).toBeTypeOf('number');
    }
  });

  it('gives every limit window an expiry, so nobody stays blocked forever', async () => {
    const ip = freshIp();
    await call(`${first.url}/t/db`, asClient(ip));
    const ttl = await redis.pttl(`rl:api:${ip}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});

describe('the client address cannot be faked from a browser', () => {
  it('ignores X-Forwarded-For entirely', async () => {
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) {
      expect(
        (await call(`${first.url}/t/db`, asClient(ip, { 'x-forwarded-for': `203.0.113.${i}` })))
          .status,
      ).toBe(200);
    }
    const blocked = await call(
      `${first.url}/t/db`,
      asClient(ip, { 'x-forwarded-for': '198.51.100.77, 192.0.2.1' }),
    );
    expectError(blocked, 429, 'rate_limited');
  });

  it('separates clients by the address nginx saw, and ignores a malformed one', async () => {
    const a = freshIp();
    const b = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await call(`${first.url}/t/db`, asClient(a));
    expect((await call(`${first.url}/t/db`, asClient(a))).status).toBe(429);
    expect((await call(`${first.url}/t/db`, asClient(b))).status).toBe(200);

    // Garbage in X-Real-IP is not an address: it falls back to the socket address (127.0.0.1)
    // and is counted there instead of creating a bucket per garbage string.
    const keys = new Set<string>();
    for (const junk of ['not an ip', '999.1.1.1', "1.1.1.1'; flushall", '']) {
      await call(`${first.url}/t/db`, asClient(junk));
    }
    for (const key of await redis.keys('rl:*')) keys.add(key);
    expect([...keys].some((key) => key.includes('not an ip') || key.includes('flushall'))).toBe(
      false,
    );
  });
});

describe('sign-in and registration paths are limited much harder', () => {
  it('blocks /auth/* after 3 requests while other paths keep their larger budget', async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i += 1) {
      // Every attempt is counted, valid or not: that is what stops brute force.
      expect(
        (await call(`${first.url}/auth/login`, { method: 'POST', ...asClient(ip) })).status,
      ).toBe(400);
    }
    expectError(
      await call(`${first.url}/auth/login`, { method: 'POST', ...asClient(ip) }),
      429,
      'rate_limited',
    );
    expect((await call(`${first.url}/t/db`, asClient(ip))).status).toBe(200);
  });
});

describe('when Redis is unreachable', () => {
  it('fails open: the API keeps serving instead of locking everyone out', async () => {
    const config = testConfig({ rateLimit: { perMinute: 1, authPerMinute: 1 } });
    const broken = await startApp({ ...config, redis: { ...config.redis, port: 1 } });
    try {
      for (let i = 0; i < 4; i += 1) {
        expect((await call(`${broken.url}/t/db`, asClient('10.9.9.9'))).status).toBe(200);
      }
    } finally {
      await broken.close();
    }
  });
});
