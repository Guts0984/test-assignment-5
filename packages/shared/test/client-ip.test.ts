import { describe, expect, it } from 'vitest';

import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  looksLikeIp,
  signClientIp,
  verifyClientIp,
} from '../src';

const SECRET = 'a-long-shared-secret-for-tests';
const NOW = 1_800_000_000_000;

const verify = (headers: Record<string, string>, secret = SECRET, now = NOW) =>
  verifyClientIp(secret, headers[CLIENT_IP_HEADER], headers[CLIENT_IP_SIGNATURE_HEADER], now);

describe('signed client address', () => {
  it('is accepted when signed with the shared secret, for IPv4 and IPv6', async () => {
    for (const ip of ['203.0.113.7', '2001:db8::1', '::ffff:192.0.2.1']) {
      expect(await verify(await signClientIp(SECRET, ip, NOW))).toBe(ip);
    }
  });

  it('is rejected if the address was changed after signing', async () => {
    const headers = await signClientIp(SECRET, '203.0.113.7', NOW);
    expect(await verify({ ...headers, [CLIENT_IP_HEADER]: '203.0.113.8' })).toBeUndefined();
  });

  it('is rejected with another secret, or with a forged or missing signature', async () => {
    const headers = await signClientIp(SECRET, '203.0.113.7', NOW);
    expect(await verify(headers, 'a-different-secret-entirely')).toBeUndefined();
    expect(await verify({ [CLIENT_IP_HEADER]: '203.0.113.7' })).toBeUndefined();
    expect(
      await verify({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: `${NOW}.${'0'.repeat(64)}` }),
    ).toBeUndefined();
    expect(await verify({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: '' })).toBeUndefined();
  });

  it('cannot be replayed with a new timestamp, and goes stale', async () => {
    const headers = await signClientIp(SECRET, '203.0.113.7', NOW);
    const mac = headers[CLIENT_IP_SIGNATURE_HEADER]!.split('.')[1];
    expect(
      await verify({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: `${NOW + 5}.${mac}` }),
    ).toBeUndefined();
    expect(await verify(headers, SECRET, NOW + 59_000)).toBe('203.0.113.7');
    expect(await verify(headers, SECRET, NOW + 61_000)).toBeUndefined(); // too old
    expect(await verify(headers, SECRET, NOW - 61_000)).toBeUndefined(); // from the future
  });

  it.each([
    'not-an-ip',
    '',
    '1.2.3',
    '999.1.1.1.1',
    '203.0.113.7, 198.51.100.1',
    '203.0.113.7\r\nX-Evil: 1',
    `${'1'.repeat(50)}`,
  ])('never accepts the junk value %j, even if it was signed', async (junk) => {
    const headers = await signClientIp(SECRET, junk, NOW);
    expect(await verify(headers)).toBeUndefined();
    expect(looksLikeIp(junk)).toBe(false);
  });

  it('copes with malformed signature headers without throwing', async () => {
    for (const signature of [
      '.',
      'a.b.c',
      `${NOW}`,
      `${NOW}.zz`,
      `${NOW}.${'f'.repeat(63)}`,
      'x'.repeat(10_000),
    ]) {
      expect(await verifyClientIp(SECRET, '203.0.113.7', signature, NOW)).toBeUndefined();
    }
  });
});
