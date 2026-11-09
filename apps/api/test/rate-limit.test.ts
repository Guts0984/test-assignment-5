import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { signClientIp } from '@kanban/shared';

import {
  call,
  expectError,
  startApp,
  TEST_CLIENT_IP_SECRET,
  testConfig,
  type RunningApp,
} from './support/app';

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

/**
 * The Next.js server calls the API on behalf of visitors, so every such call comes from the SAME
 * address (the web server). Without the visitor's address passed along and verified, they would
 * all share one counter: one spammer would lock out everybody.
 */
describe('calls made by the web server on behalf of visitors', () => {
  const secret = TEST_CLIENT_IP_SECRET;
  const onBehalfOf = async (ip: string, extra: Record<string, string> = {}) => ({
    headers: { ...(await signClientIp(secret, ip)), ...extra },
  });
  const hitMany = async (n: number, init: () => Promise<{ headers: Record<string, string> }>) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i += 1)
      statuses.push((await call(`${first.url}/t/db`, await init())).status);
    return statuses;
  };

  it('counts every visitor separately, although all calls share one connection address', async () => {
    const [a, b] = [freshIp(), freshIp()];
    expect(await hitMany(LIMIT, () => onBehalfOf(a))).toEqual(Array(LIMIT).fill(200));
    expect((await call(`${first.url}/t/db`, await onBehalfOf(a))).status).toBe(429); // visitor A is out of budget...
    expect(await hitMany(LIMIT, () => onBehalfOf(b))).toEqual(Array(LIMIT).fill(200)); // ...visitor B is not affected
  });

  it('counts per visitor on both instances', async () => {
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) {
      expect(
        (await call(`${i % 2 ? first.url : second.url}/t/db`, await onBehalfOf(ip))).status,
      ).toBe(200);
    }
    expectError(await call(`${second.url}/t/db`, await onBehalfOf(ip)), 429, 'rate_limited');
    expectError(await call(`${first.url}/t/db`, await onBehalfOf(ip)), 429, 'rate_limited');
  });

  it('prefers the signed address over the one nginx put in X-Real-IP', async () => {
    const visitor = freshIp();
    const nginxSaw = freshIp();
    for (let i = 0; i < LIMIT; i += 1)
      await call(`${first.url}/t/db`, await onBehalfOf(visitor, { 'x-real-ip': nginxSaw }));
    expect(
      (await call(`${first.url}/t/db`, await onBehalfOf(visitor, { 'x-real-ip': nginxSaw })))
        .status,
    ).toBe(429);
    expect((await call(`${first.url}/t/db`, asClient(nginxSaw))).status).toBe(200); // nginx's address was not charged
  });

  it('does not let a browser choose its own address: unsigned, forged or stale claims are ignored', async () => {
    const real = freshIp();
    const forgeries: Record<string, string>[] = [
      { 'x-client-ip': '203.0.113.1' }, // no signature at all
      { ...(await signClientIp('some-other-secret-0123456789', '203.0.113.2')) }, // signed with a guessed secret
      { ...(await signClientIp(secret, '203.0.113.3', Date.now() - 120_000)) }, // too old
      { ...(await signClientIp(secret, '203.0.113.4')), 'x-client-ip': '203.0.113.5' }, // address swapped after signing
      { 'x-client-ip': '203.0.113.6', 'x-client-ip-signature': 'garbage' },
    ];
    // All of them fall back to the real address, so changing the claim never yields a fresh budget.
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + forgeries.length; i += 1) {
      const forged = forgeries[i % forgeries.length] ?? {};
      statuses.push((await call(`${first.url}/t/db`, asClient(real, forged))).status);
    }
    expect(statuses.slice(0, LIMIT).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(LIMIT).every((s) => s === 429)).toBe(true);
  });

  it('shows the cost of forgetting to pass the address: every visitor shares one budget', async () => {
    // The same situation as above, but the web server "forgot" the header: all visitors look alike.
    const sharedPeer = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await call(`${first.url}/t/db`, asClient(sharedPeer)); // visitor A spends it all
    expect((await call(`${first.url}/t/db`, asClient(sharedPeer))).status).toBe(429); // visitor B is locked out too
  });
});
