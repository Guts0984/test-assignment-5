import { signClientIp } from '@kanban/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import { startApp, TEST_CLIENT_IP_SECRET, testConfig, type RunningApp } from './support/app';
import { registerUser, type TestUser } from './support/world';

/**
 * WebSocket traffic never passes through the HTTP rate limiter (Express does not see it), so
 * Socket.IO has limits of its own. These tests make sure a visitor cannot get around them by
 * opening many connections, by faking headers, or by using the other API instance.
 */
const sockets: Socket[] = [];
const apps: RunningApp[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freshIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const launch = async (
  rateLimit: Parameters<typeof testConfig>[0] extends infer T
    ? NonNullable<T> extends { rateLimit?: infer R }
      ? R
      : never
    : never,
  count = 1,
) => {
  const config = testConfig({ rateLimit });
  const started = await Promise.all(Array.from({ length: count }, () => startApp(config)));
  apps.push(...started);
  return started;
};

type Attempt = { socket: Socket; outcome: string };

/** One browser tab connecting; `headers` is what nginx (or the web server) would add. */
const tryConnect = async (
  server: RunningApp,
  user: Pick<TestUser, 'cookie'>,
  headers: Record<string, string> = {},
): Promise<Attempt> => {
  const socket = connect(server.url, {
    transports: ['websocket'],
    extraHeaders: { cookie: user.cookie, ...headers },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  const outcome = await new Promise<string>((resolve) => {
    socket.once('connect', () => resolve('connected'));
    socket.once('connect_error', (error) => resolve(error.message));
  });
  return { socket, outcome };
};

describe('connections per visitor', () => {
  it('are limited per minute, counted across both API instances', async () => {
    const [one, two] = await launch({ wsConnectsPerMinute: 5 }, 2);
    const user = await registerUser(one!.url, 'ws');
    const ip = freshIp();

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1)
      outcomes.push((await tryConnect(i % 2 ? one! : two!, user, { 'x-real-ip': ip })).outcome);
    expect(outcomes).toEqual(Array(5).fill('connected'));

    // the 6th, on EITHER instance, is over the shared limit
    expect((await tryConnect(one!, user, { 'x-real-ip': ip })).outcome).not.toBe('connected');
    expect((await tryConnect(two!, user, { 'x-real-ip': ip })).outcome).not.toBe('connected');
    // somebody else is not affected
    expect((await tryConnect(one!, user, { 'x-real-ip': freshIp() })).outcome).toBe('connected');
  });

  it('cannot be reset by faking X-Forwarded-For, or by claiming an address without the signature', async () => {
    const [app] = await launch({ wsConnectsPerMinute: 3 });
    const user = await registerUser(app!.url, 'ws');
    const ip = freshIp();
    for (let i = 0; i < 3; i += 1) await tryConnect(app!, user, { 'x-real-ip': ip });

    const forgeries: Record<string, string>[] = [
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '203.0.113.10, 198.51.100.1' },
      { 'x-client-ip': '203.0.113.11' },
      { 'x-client-ip': '203.0.113.12', 'x-client-ip-signature': 'garbage' },
      { ...(await signClientIp('guessed-secret-0123456789abc', '203.0.113.13')) },
    ];
    for (const forged of forgeries) {
      expect(
        (await tryConnect(app!, user, { 'x-real-ip': ip, ...forged })).outcome,
        JSON.stringify(forged),
      ).not.toBe('connected');
    }
  });

  it('are counted per visitor when the address is vouched for by the web server', async () => {
    const [app] = await launch({ wsConnectsPerMinute: 2 });
    const user = await registerUser(app!.url, 'ws');
    const visitor = freshIp();
    const vouched = async (ip: string) => ({ ...(await signClientIp(TEST_CLIENT_IP_SECRET, ip)) });
    expect((await tryConnect(app!, user, await vouched(visitor))).outcome).toBe('connected');
    expect((await tryConnect(app!, user, await vouched(visitor))).outcome).toBe('connected');
    expect((await tryConnect(app!, user, await vouched(visitor))).outcome).not.toBe('connected');
    expect((await tryConnect(app!, user, await vouched(freshIp()))).outcome).toBe('connected'); // another visitor, same peer address
  });

  it('are limited in number at the same time, and closing one frees a place', async () => {
    const [app] = await launch({ wsMaxConnectionsPerIp: 3 });
    const user = await registerUser(app!.url, 'ws');
    const ip = freshIp();
    const open = [];
    for (let i = 0; i < 3; i += 1) open.push(await tryConnect(app!, user, { 'x-real-ip': ip }));
    expect(open.map((a) => a.outcome)).toEqual(['connected', 'connected', 'connected']);
    expect((await tryConnect(app!, user, { 'x-real-ip': ip })).outcome).not.toBe('connected');

    open[0]!.socket.disconnect();
    await sleep(300);
    expect((await tryConnect(app!, user, { 'x-real-ip': ip })).outcome).toBe('connected');
  });

  it('refuse a visitor without a session before any limit even matters', async () => {
    const [app] = await launch({ wsConnectsPerMinute: 1_000 });
    expect((await tryConnect(app!, { cookie: '' })).outcome).toBe('unauthorized');
  });
});

/** A message that is processed is answered; a dropped one is not. This counts the answers. */
const NOWHERE = { boardId: '123e4567-e89b-42d3-a456-426614174000' };
const sendAndCountAnswers = async (
  tab: Attempt,
  count: number,
  waitMs = 1_500,
): Promise<number> => {
  let answered = 0;
  for (let i = 0; i < count; i += 1) tab.socket.emit('board.join', NOWHERE, () => (answered += 1));
  await sleep(waitMs);
  return answered;
};

describe('messages per visitor', () => {
  it('are limited over ALL of a visitor’s connections, so opening more sockets gains nothing', async () => {
    const [one, two] = await launch({ wsMessagesPer10s: 40 }, 2);
    const user = await registerUser(one!.url, 'ws');
    const ip = freshIp();
    const tabs = [
      await tryConnect(one!, user, { 'x-real-ip': ip }),
      await tryConnect(two!, user, { 'x-real-ip': ip }),
      await tryConnect(one!, user, { 'x-real-ip': ip }),
    ];

    // 3 tabs x 25 messages = 75; each tab is far below its own allowance, the visitor's total is not
    const answers = await Promise.all(tabs.map((tab) => sendAndCountAnswers(tab, 25)));
    const total = answers.reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThanOrEqual(40); // the visitor's budget, however many sockets it used
    expect(total).toBeGreaterThanOrEqual(35); // and the budget was actually usable
  });

  it('do not affect other visitors', async () => {
    const [app] = await launch({ wsMessagesPer10s: 20 });
    const user = await registerUser(app!.url, 'ws');
    const noisy = await tryConnect(app!, user, { 'x-real-ip': freshIp() });
    const calm = await tryConnect(app!, user, { 'x-real-ip': freshIp() });
    const [noisyAnswers, calmAnswers] = await Promise.all([
      sendAndCountAnswers(noisy, 28),
      sendAndCountAnswers(calm, 5),
    ]);
    expect(noisyAnswers).toBeLessThanOrEqual(20);
    expect(calmAnswers).toBe(5);
  });

  it('count a visitor the same way over HTTP and WebSocket (one identity: the vouched address)', async () => {
    const [app] = await launch({ wsMessagesPer10s: 5 });
    const user = await registerUser(app!.url, 'ws');
    const visitor = freshIp();
    const tab = await tryConnect(app!, user, await signClientIp(TEST_CLIENT_IP_SECRET, visitor));
    expect(await sendAndCountAnswers(tab, 12)).toBeLessThanOrEqual(5);
    // another visitor behind the same web server connection keeps its own budget
    const other = await tryConnect(
      app!,
      user,
      await signClientIp(TEST_CLIENT_IP_SECRET, freshIp()),
    );
    expect(await sendAndCountAnswers(other, 5)).toBe(5);
  });
});
