import { joinResultSchema, type JoinResult } from '@kanban/shared';
import { Logger } from '@nestjs/common';
import { io as connect, type Socket } from 'socket.io-client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { BoardsService } from '../src/boards/boards.service';
import { WorkspaceAccessService } from '../src/workspaces/workspace-access.service';
import { call, startApp, testConfig, type RunningApp } from './support/app';
import { asJson, makeBoard, makeWorkspace, registerUser, type TestUser } from './support/world';

/**
 * Joining a board is the one expensive socket message (it builds a full board snapshot), so it
 * has a much tighter budget than ordinary messages, and a failing database must never look like
 * "board not found".
 */
const JOINS_PER_10S = 20;
const SOCKET_BURST = 5; // what ONE socket may do in an instant (see realtime.service.ts)

let one: RunningApp;
let two: RunningApp;
let alice: TestUser; // owner
let bob: TestUser; // editor, the well-behaved bystander
let board: { id: string; columnIds: string[] };
let snapshots: MockInstance<(userId: string, boardId: string) => Promise<unknown>>[];

const sockets: Socket[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freshIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const open = async (server: RunningApp, user: TestUser, ip = freshIp()): Promise<Socket> => {
  const socket = connect(server.url, {
    transports: ['websocket'],
    extraHeaders: { cookie: user.cookie, 'x-real-ip': ip },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
};

const join = (socket: Socket, boardId = board.id): Promise<JoinResult> =>
  socket
    .timeout(10_000)
    .emitWithAck('board.join', { boardId })
    .then((raw) => joinResultSchema.parse(raw));

/**
 * Sends `count` joins at once and returns the answers that arrive. Messages dropped by the general
 * per-socket flood limit get no answer at all, so this waits a fixed time instead of for all.
 */
const flood = async (socket: Socket, count: number, waitMs = 3_000): Promise<JoinResult[]> => {
  const answers: JoinResult[] = [];
  for (let i = 0; i < count; i += 1)
    socket.emit('board.join', { boardId: board.id }, (raw: unknown) =>
      answers.push(joinResultSchema.parse(raw)),
    );
  await sleep(waitMs);
  return answers;
};

/** A client that keeps asking, one join after the other (below the general message limit), ignoring refusals. */
const persistent = async (socket: Socket, count: number): Promise<JoinResult[]> => {
  const answers: JoinResult[] = [];
  for (let i = 0; i < count; i += 1) {
    answers.push(await join(socket));
    await sleep(80);
  }
  return answers;
};

/** How many board snapshots the two instances have built so far. */
const built = () => snapshots.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

beforeAll(async () => {
  const config = testConfig({ rateLimit: { wsJoinsPer10s: JOINS_PER_10S } });
  [one, two] = await Promise.all([startApp(config), startApp(config)]);
  snapshots = [one, two].map((app) => vi.spyOn(app.app.get(BoardsService), 'get'));
});

/** Fresh users and board per test: the join budgets are per user and would leak between tests. */
beforeEach(async () => {
  [alice, bob] = (await Promise.all(['alice', 'bob'].map((n) => registerUser(one.url, n)))) as [
    TestUser,
    TestUser,
  ];
  const workspace = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: bob, role: 'editor' },
  ]);
  board = await makeBoard(workspace.id);
  for (const spy of snapshots) spy.mockClear();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all([one.close(), two.close()]);
});

describe('a flood of board.join', () => {
  it('builds only a handful of snapshots, however many sockets and messages one visitor uses', async () => {
    const ip = freshIp();
    const flooders = await Promise.all(
      Array.from({ length: 10 }, (_, i) => open(i % 2 ? one : two, alice, ip)),
    );
    const flat = (await Promise.all(flooders.map((socket) => persistent(socket, 40)))).flat();
    expect(flat).toHaveLength(400); // all answered, none left hanging
    const accepted = flat.filter((a) => a.ok).length;
    const refused = flat.filter((a) => !a.ok);
    expect(refused.every((a) => !a.ok && a.error === 'rate_limited')).toBe(true);
    // the visitor's shared budget (both instances), not 10 sockets x their own allowance
    expect(accepted).toBeLessThanOrEqual(JOINS_PER_10S);
    expect(built()).toBeLessThanOrEqual(JOINS_PER_10S); // and no snapshot was built for a refused join
  }, 30_000);

  it('is also limited per user, so spreading one account over many addresses gains nothing', async () => {
    const flooders = await Promise.all(
      Array.from({ length: 10 }, (_, i) => open(i % 2 ? one : two, alice)), // each its own address
    );
    await Promise.all(flooders.map((socket) => persistent(socket, 10)));
    expect(built()).toBeLessThanOrEqual(JOINS_PER_10S);
  }, 30_000);

  it('is also limited per address, so many accounts behind one address gain nothing', async () => {
    const crowd = await Promise.all(
      Array.from({ length: 10 }, (_, i) => registerUser(one.url, `crowd${i}`)),
    );
    const workspace = await makeWorkspace(crowd.map((user) => ({ user, role: 'viewer' as const })));
    board = await makeBoard(workspace.id);
    const ip = freshIp();
    const flooders = await Promise.all(crowd.map((user, i) => open(i % 2 ? one : two, user, ip))); // ten accounts, one address
    await Promise.all(flooders.map((socket) => persistent(socket, 10)));
    expect(built()).toBeLessThanOrEqual(JOINS_PER_10S);
  }, 30_000);

  it('does not stop a well-behaved user, on another address, from joining while it runs', async () => {
    const ip = freshIp();
    const flooders = await Promise.all(
      Array.from({ length: 6 }, (_, i) => open(i % 2 ? one : two, alice, ip)),
    );
    const flooding = Promise.all(flooders.map((socket) => persistent(socket, 40)));
    const calm = await open(two, bob);
    const result = await join(calm);
    expect(result.ok).toBe(true);
    await flooding;
    // and still afterwards, while the flooder is locked out
    expect((await join(await open(one, bob))).ok).toBe(true);
  }, 30_000);

  it('is limited per socket too, before the shared budget matters', async () => {
    const socket = await open(one, alice);
    const answers = await flood(socket, 100);
    expect(answers.filter((a) => a.ok).length).toBeLessThanOrEqual(SOCKET_BURST);
    expect(built()).toBeLessThanOrEqual(SOCKET_BURST);
    expect(answers.some((a) => !a.ok && a.error === 'rate_limited')).toBe(true);
  });

  it('answers simultaneous joins of one board from one socket with one snapshot', async () => {
    const socket = await open(one, alice);
    const answers = await Promise.all([join(socket), join(socket), join(socket)]);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(built()).toBe(1);
  });

  it('still gives a reconnecting client the current board (a new socket has its own allowance)', async () => {
    const ip = freshIp();
    const before = await open(one, alice, ip);
    expect((await join(before)).ok).toBe(true);
    before.disconnect();
    const created = await call(
      `${two.url}/boards/${board.id}/cards`,
      asJson(alice, 'POST', { columnId: board.columnIds[0], title: 'made while away' }),
    );
    expect(created.status).toBe(201);
    const after = await join(await open(two, alice, ip));
    expect(after.ok && after.snapshot.cards.map((c) => c.title)).toContain('made while away');
  });
});

describe('a database failure while joining', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is reported as unavailable, never as not_found, and is logged', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const socket = await open(one, alice);
    const failure = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(one.app.get(WorkspaceAccessService), 'requireForBoard').mockRejectedValueOnce(failure);
    expect(await join(socket)).toEqual({ ok: false, error: 'unavailable' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ECONNREFUSED'))).toBe(true);
    // the very next attempt works: the failure left nothing broken behind
    await sleep(1_100);
    expect((await join(socket)).ok).toBe(true);
  });

  it('does not change the answer for a board that really is missing or forbidden', async () => {
    const socket = await open(one, alice);
    expect(await join(socket, '123e4567-e89b-42d3-a456-426614174999')).toEqual({
      ok: false,
      error: 'not_found',
    });
  });
});
