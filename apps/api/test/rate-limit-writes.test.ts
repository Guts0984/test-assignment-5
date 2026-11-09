import { workspaceMembers } from '@kanban/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, startApp, testConfig, type RunningApp } from './support/app';
import { asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

/** The new write routes sit behind the same per-IP limiter as everything else. */
const LIMIT = 6;
let first: RunningApp;
let second: RunningApp;
let user: TestUser;
let boardId: string;

beforeAll(async () => {
  const config = testConfig({ rateLimit: { perMinute: LIMIT, authPerMinute: 1000 } });
  [first, second] = await Promise.all([startApp(config), startApp(config)]);
  user = await registerUser(first.url, 'rl');
  const workspace = await makeWorkspace([{ user, role: 'owner' }], ['Limited']);
  boardId = workspace.boardIds[0]!;
});
afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
});

const freshIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const from = (ip: string, extra: Record<string, string> = {}) => ({
  ...asJson(user, 'POST', { name: 'x' }),
  headers: { cookie: user.cookie, 'x-real-ip': ip, ...extra },
});
const ownedCount = async () =>
  (await testDb().db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)))
    .length;

describe('creating, renaming and deleting are limited per visitor IP, across both instances', () => {
  it('the overflow is a 429 and does nothing; a different visitor is not affected', async () => {
    const noisy = freshIp();
    const quiet = freshIp();
    const before = await ownedCount();
    const targets = [first, second];

    // mixed write routes on alternating instances all count into ONE bucket for this IP
    const calls = [
      (t: RunningApp) => call(`${t.url}/workspaces`, from(noisy)),
      (t: RunningApp) => call(`${t.url}/boards/${boardId}`, { ...from(noisy), method: 'PATCH' }),
      (t: RunningApp) => call(`${t.url}/workspaces`, from(noisy)),
    ];
    for (let i = 0; i < LIMIT; i += 1)
      expect((await calls[i % 3]!(targets[i % 2]!)).status, `request ${i + 1}`).not.toBe(429);

    for (const target of targets) {
      const blocked = await call(`${target.url}/workspaces`, from(noisy));
      expect(blocked.status).toBe(429);
    }
    expect(
      (await call(`${first.url}/boards/${boardId}`, { ...from(noisy), method: 'DELETE' })).status,
    ).toBe(429);
    // 4 of the 6 allowed requests were POST /workspaces; the blocked ones created nothing
    expect((await ownedCount()) - before).toBe(4);
    expect(
      await call(`${first.url}/boards/${boardId}`, from(noisy, {})).then((r) => r.status),
    ).toBe(429);

    // another visitor still gets through
    expect((await call(`${second.url}/workspaces`, from(quiet))).status).toBe(201);
  });

  it('a forged X-Forwarded-For or a client-supplied signature header gives no extra allowance', async () => {
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1)
      await call(`${first.url}/workspaces`, from(ip, { 'x-forwarded-for': freshIp() }));
    const forged = await call(
      `${second.url}/workspaces`,
      from(ip, {
        'x-forwarded-for': freshIp(),
        'x-client-ip': freshIp(),
        'x-client-ip-signature': 'deadbeef',
      }),
    );
    expect(forged.status).toBe(429);
  });
});
