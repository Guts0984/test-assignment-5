import { workspaceMembers } from '@kanban/db';
import {
  boardSchema,
  cardSchema,
  joinResultSchema,
  PRESENCE_HEARTBEAT_MS,
  presenceUserSchema,
  type JoinResult,
  type PresenceUser,
} from '@kanban/shared';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { call, startApp, testConfig, type RunningApp } from './support/app';
import {
  asJson,
  makeBoard,
  makeWorkspace,
  registerUser,
  testDb,
  type TestUser,
} from './support/world';

let one: RunningApp; // two real API instances
let two: RunningApp;
let alice: TestUser; // owner
let bob: TestUser; // editor
let carol: TestUser; // viewer
let dave: TestUser; // owner of another workspace
let workspaceId: string;
let board: { id: string; columnIds: string[] };
let otherBoard: { id: string; columnIds: string[] };
let redis: Redis;

const sockets: Socket[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Client = {
  socket: Socket;
  received: { name: string; payload: Record<string, unknown> }[];
  presence: () => PresenceUser[];
};

/** A browser tab: connects with the session cookie and records every message from the server. */
const open = async (
  server: RunningApp,
  user: Pick<TestUser, 'cookie'>,
  headers: Record<string, string> = {},
): Promise<Client> => {
  const socket = connect(server.url, {
    transports: ['websocket'],
    extraHeaders: { cookie: user.cookie, ...headers },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  const received: Client['received'] = [];
  socket.onAny((name: string, payload: Record<string, unknown>) =>
    received.push({ name, payload }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const presence = () => {
    const last = [...received].reverse().find((m) => m.name === 'presence.snapshot');
    return ((last?.payload.users as unknown[]) ?? []).map((u) => presenceUserSchema.parse(u));
  };
  return { socket, received, presence };
};

const join = (client: Client, boardId = board.id): Promise<JoinResult> =>
  client.socket.timeout(5_000).emitWithAck('board.join', { boardId }) as Promise<JoinResult>;
const namesOf = (client: Client) => client.received.map((m) => m.name);
const waitFor = async (probe: () => boolean, ms = 8_000, what = 'condition') => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const newCard = async (title = 'rt card', server = one) =>
  cardSchema.parse(
    (
      await call(
        `${server.url}/boards/${board.id}/cards`,
        asJson(alice, 'POST', { columnId: board.columnIds[0], title }),
      )
    ).body,
  );

beforeAll(async () => {
  const config = testConfig();
  [one, two] = await Promise.all([startApp(config), startApp(config)]);
  const users = await Promise.all(
    ['alice', 'bob', 'carol', 'dave'].map((n) => registerUser(one.url, n)),
  );
  [alice, bob, carol, dave] = users as [TestUser, TestUser, TestUser, TestUser];
  const workspace = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: bob, role: 'editor' },
    { user: carol, role: 'viewer' },
  ]);
  workspaceId = workspace.id;
  board = await makeBoard(workspaceId);
  otherBoard = await makeBoard((await makeWorkspace([{ user: dave, role: 'owner' }])).id);
  const { host, port, password } = inject('infra').redis;
  redis = new Redis({ host, port, password });
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});

afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
  redis.disconnect();
});

describe('connecting', () => {
  it('needs the session cookie: none, a forged one, or a logged-out one is refused', async () => {
    await expect(open(one, { cookie: '' })).rejects.toThrow('unauthorized');
    await expect(open(one, { cookie: `sid=${'a'.repeat(43)}` })).rejects.toThrow('unauthorized');
    await expect(open(one, { cookie: 'sid=garbage' })).rejects.toThrow('unauthorized');

    const leaver = await registerUser(one.url, 'leaver');
    await call(`${one.url}/auth/logout`, { method: 'POST', headers: { cookie: leaver.cookie } });
    await expect(open(one, leaver)).rejects.toThrow('unauthorized');
    expect((await open(one, alice)).socket.connected).toBe(true);
  });

  it('refuses a page from another origin (cross-site WebSocket hijacking)', async () => {
    await expect(open(one, alice, { origin: 'https://evil.example' })).rejects.toThrow('forbidden');
    expect((await open(one, alice, { origin: 'http://localhost:8080' })).socket.connected).toBe(
      true,
    );
  });

  it('is WebSocket only: the long-polling transport is not offered', async () => {
    const polling = connect(one.url, {
      transports: ['polling'],
      extraHeaders: { cookie: alice.cookie },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(polling);
    await expect(
      new Promise<void>((resolve, reject) => {
        polling.once('connect', () => resolve());
        polling.once('connect_error', reject);
      }),
    ).rejects.toBeDefined();
  });
});

describe('joining a board', () => {
  it('gives members the current board, the people present, and a point to continue from', async () => {
    const card = await newCard();
    const client = await open(one, carol); // a viewer may watch
    const result = joinResultSchema.parse(await join(client));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.role).toBe('viewer');
    expect(result.snapshot.cards.map((c) => c.id)).toContain(card.id);
    const http = boardSchema.parse(
      (await call(`${one.url}/boards/${board.id}`, { headers: { cookie: carol.cookie } })).body,
    );
    expect(result.snapshot).toEqual(http);
    expect(result.lastEventId).toBeGreaterThan(0);
    expect(result.presence.map((p) => p.user.id)).toEqual([carol.id]);
  });

  it('refuses outsiders and unknown or malformed boards, all with the same answer', async () => {
    const outsider = await open(one, dave);
    const answers = await Promise.all([
      join(outsider, board.id),
      join(outsider, '123e4567-e89b-42d3-a456-426614174999'),
    ]);
    expect(answers).toEqual([
      { ok: false, error: 'not_found' },
      { ok: false, error: 'not_found' },
    ]);
    for (const junk of [null, 'nope', {}, { boardId: 5 }, { boardId: 'x' }, []]) {
      expect(
        await (outsider.socket
          .timeout(5_000)
          .emitWithAck('board.join', junk) as Promise<JoinResult>),
      ).toEqual({ ok: false, error: 'not_found' });
    }
    await newCard('after the refusals');
    await sleep(300);
    expect(namesOf(outsider).filter((n) => n.startsWith('card.'))).toEqual([]); // nothing leaked
  });
});

describe('changes reach everyone watching, through either API instance', () => {
  it('delivers each change once, in order, with the sender’s mutation id', async () => {
    const onOne = await open(one, alice);
    const onTwo = await open(two, carol);
    const elsewhere = await open(one, dave);
    await Promise.all([join(onOne), join(onTwo), join(elsewhere, otherBoard.id)]);

    // the change is made through instance ONE; the viewer is connected to instance TWO
    const created = cardSchema.parse(
      (
        await call(
          `${one.url}/boards/${board.id}/cards`,
          asJson(bob, 'POST', {
            columnId: board.columnIds[0],
            title: 'live',
            clientMutationId: 'm-1',
          }),
        )
      ).body,
    );
    await call(
      `${two.url}/cards/${created.id}/move`,
      asJson(bob, 'POST', { columnId: board.columnIds[1], clientMutationId: 'm-2' }),
    );
    await call(
      `${one.url}/cards/${created.id}`,
      asJson(alice, 'PATCH', { version: 1, title: 'renamed', clientMutationId: 'm-3' }),
    );

    for (const client of [onOne, onTwo]) {
      await waitFor(
        () => client.received.filter((m) => m.name.startsWith('card.')).length >= 3,
        5_000,
        'three card events',
      );
      const events = client.received.filter((m) => m.name.startsWith('card.'));
      expect(events.map((e) => e.name)).toEqual(['card.created', 'card.moved', 'card.updated']);
      expect(events.map((e) => e.payload.clientMutationId)).toEqual(['m-1', 'm-2', 'm-3']);
      const ids = events.map((e) => e.payload.eventId as number);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      expect(events[1]?.payload).toMatchObject({
        fromColumnId: board.columnIds[0],
        card: { id: created.id, columnId: board.columnIds[1] },
      });
      expect(events[2]?.payload).toMatchObject({ card: { title: 'renamed', version: 2 } });
    }
    await sleep(300);
    expect(namesOf(elsewhere).filter((n) => n.startsWith('card.'))).toEqual([]); // another board hears nothing
  });

  it('does not deliver to someone who left the board or never joined', async () => {
    const watcher = await open(one, alice);
    const leaver = await open(two, bob);
    const stranger = await open(two, carol);
    await Promise.all([join(watcher), join(leaver)]);
    leaver.socket.emit('board.leave', { boardId: board.id });
    await sleep(300);
    await newCard('after leaving');
    await waitFor(() => namesOf(watcher).includes('card.created'));
    await sleep(300);
    expect(namesOf(leaver).filter((n) => n.startsWith('card.'))).toEqual([]);
    expect(namesOf(stranger)).toEqual([]);
  });

  it('brings a client that was away back up to date when it joins again', async () => {
    const client = await open(one, alice);
    await join(client);
    client.socket.disconnect();
    const missed = await newCard('made while offline');
    const again = await open(two, alice);
    const result = joinResultSchema.parse(await join(again));
    expect(result.ok && result.snapshot.cards.map((c) => c.id)).toContain(missed.id);
  });
});

describe('presence', () => {
  it('shows who is on the board across instances, and what they are editing', async () => {
    const card = await newCard('being edited');
    const a = await open(one, alice);
    const b = await open(two, bob);
    await Promise.all([join(a), join(b)]);
    await waitFor(
      () => a.presence().length === 2 && b.presence().length === 2,
      5_000,
      'both users listed',
    );
    expect(
      a
        .presence()
        .map((p) => p.user.id)
        .sort(),
    ).toEqual([alice.id, bob.id].sort());

    b.socket.emit('presence.editing', { boardId: board.id, cardId: card.id });
    await waitFor(
      () => a.presence().find((p) => p.user.id === bob.id)?.editingCardId === card.id,
      5_000,
      'editing shown',
    );
    b.socket.emit('presence.editing', { boardId: board.id, cardId: null });
    await waitFor(
      () => a.presence().find((p) => p.user.id === bob.id)?.editingCardId === null,
      5_000,
      'editing cleared',
    );
  });

  it('removes a closed tab at once, but keeps the user while another tab is open', async () => {
    const watcher = await open(one, alice);
    const tabOne = await open(two, bob);
    const tabTwo = await open(one, bob);
    await Promise.all([join(watcher), join(tabOne), join(tabTwo)]);
    await waitFor(() => watcher.presence().some((p) => p.user.id === bob.id), 5_000, 'bob listed');

    tabOne.socket.disconnect();
    await sleep(800);
    expect(watcher.presence().map((p) => p.user.id)).toContain(bob.id); // still has a tab open

    const closedAt = Date.now();
    tabTwo.socket.disconnect();
    await waitFor(() => !watcher.presence().some((p) => p.user.id === bob.id), 10_000, 'bob gone');
    expect(Date.now() - closedAt).toBeLessThan(3_000);
  });

  it('forgets a client that vanished without saying goodbye within 10 seconds', async () => {
    const watcher = await open(two, alice);
    await join(watcher);
    // As left behind by an instance that crashed: an entry that nobody refreshes any more.
    const ghost = {
      user: { id: dave.id, handle: dave.handle, name: dave.name },
      editingCardId: null,
    };
    await redis.zadd(`presence:${board.id}`, Date.now() + 3_000, 'ghost-socket');
    await redis.hset(`presence:data:${board.id}`, 'ghost-socket', JSON.stringify(ghost));
    watcher.socket.emit('presence.heartbeat', { boardId: board.id });
    await join(watcher); // any change makes the server publish a fresh list
    await waitFor(
      () => watcher.presence().some((p) => p.user.id === dave.id),
      3_000,
      'ghost visible',
    );

    const since = Date.now();
    await waitFor(
      () => !watcher.presence().some((p) => p.user.id === dave.id),
      10_000,
      'ghost expired',
    );
    expect(Date.now() - since).toBeLessThan(10_000);
  }, 20_000);

  it('drops a client that stays connected but stops sending heartbeats', async () => {
    const watcher = await open(one, alice);
    const frozen = await open(two, bob); // e.g. a frozen browser tab: the socket is up, the page is not responding
    await Promise.all([join(watcher), join(frozen)]);
    await waitFor(() => watcher.presence().some((p) => p.user.id === bob.id), 5_000, 'bob listed');

    const since = Date.now();
    await waitFor(
      () => !watcher.presence().some((p) => p.user.id === bob.id),
      10_000,
      'frozen client dropped',
    );
    expect(Date.now() - since).toBeLessThan(10_000);
    expect(frozen.socket.connected).toBe(true);
  }, 20_000);

  it('shows what a user edits even when their other tab is idle', async () => {
    const card = await newCard('two tabs');
    const watcher = await open(one, alice);
    const editing = await open(one, bob);
    await Promise.all([join(watcher), join(editing)]);
    editing.socket.emit('presence.editing', { boardId: board.id, cardId: card.id });
    await waitFor(
      () => watcher.presence().find((p) => p.user.id === bob.id)?.editingCardId === card.id,
    );

    const snapshots = () => watcher.received.filter((m) => m.name === 'presence.snapshot').length;
    const seen = snapshots();
    const idle = await open(two, bob); // opened later, so it is the newest entry
    await join(idle);
    await waitFor(() => snapshots() > seen, 5_000, 'a list published after the second tab joined');
    await sleep(200);
    const bobs = watcher.presence().filter((p) => p.user.id === bob.id);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]?.editingCardId).toBe(card.id);
  });

  it('keeps a live client listed for as long as it keeps sending heartbeats', async () => {
    const watcher = await open(one, alice);
    const staying = await open(two, bob);
    await Promise.all([join(watcher), join(staying)]);
    const beat = setInterval(
      () => staying.socket.emit('presence.heartbeat', { boardId: board.id }),
      PRESENCE_HEARTBEAT_MS,
    );
    try {
      await sleep(9_000);
      expect(watcher.presence().map((p) => p.user.id)).toContain(bob.id);
    } finally {
      clearInterval(beat);
    }
  }, 20_000);
});

describe('viewers can only watch', () => {
  it('a viewer’s presence messages change nothing, an editor’s do', async () => {
    const card = await newCard('viewer test');
    const watcher = await open(one, alice);
    const viewer = await open(two, carol);
    const editor = await open(one, bob);
    await Promise.all([join(watcher), join(viewer), join(editor)]);

    viewer.socket.emit('presence.editing', { boardId: board.id, cardId: card.id });
    await sleep(500);
    expect(
      watcher.presence().find((p) => p.user.id === carol.id)?.editingCardId ?? null,
    ).toBeNull();

    editor.socket.emit('presence.editing', { boardId: board.id, cardId: card.id });
    await waitFor(
      () => watcher.presence().find((p) => p.user.id === bob.id)?.editingCardId === card.id,
    );
  });

  it('nobody can announce editing a card that is not on the board', async () => {
    const watcher = await open(one, alice);
    const editor = await open(two, bob);
    await Promise.all([join(watcher), join(editor)]);
    editor.socket.emit('presence.editing', {
      boardId: board.id,
      cardId: '123e4567-e89b-42d3-a456-426614174999',
    });
    await sleep(500);
    expect(watcher.presence().find((p) => p.user.id === bob.id)?.editingCardId ?? null).toBeNull();
  });

  it('messages for a board that was never joined, and unknown events, are ignored', async () => {
    const watcher = await open(one, alice);
    const intruder = await open(two, dave);
    await join(watcher);
    intruder.socket.emit('presence.editing', { boardId: board.id, cardId: null });
    intruder.socket.emit('presence.heartbeat', { boardId: board.id });
    intruder.socket.emit('card.move', { cardId: 'x' });
    intruder.socket.emit('board.delete', {});
    await sleep(500);
    expect(watcher.presence().map((p) => p.user.id)).toEqual([alice.id]);
    expect(intruder.socket.connected).toBe(true);
  });
});

describe('losing access', () => {
  it('a removed member stops receiving changes at once, even on another instance', async () => {
    const member = await registerUser(one.url, 'removed');
    const W = await makeWorkspace([
      { user: alice, role: 'owner' },
      { user: member, role: 'editor' },
    ]);
    const B = await makeBoard(W.id);
    const watcher = await open(one, alice);
    const doomed = await open(two, member);
    await Promise.all([join(watcher, B.id), join(doomed, B.id)]);
    await waitFor(() => watcher.presence().length === 2);

    const edit = (title: string) =>
      call(
        `${one.url}/boards/${B.id}/cards`,
        asJson(alice, 'POST', { columnId: B.columnIds[0], title }),
      );
    await edit('before removal');
    await waitFor(() => namesOf(doomed).includes('card.created'));

    doomed.received.length = 0;
    const removal = await call(`${one.url}/workspaces/${W.id}/members/${member.id}`, {
      method: 'DELETE',
      headers: { cookie: alice.cookie },
    });
    expect(removal.status).toBe(204);
    await waitFor(() => namesOf(doomed).includes('access.revoked'), 3_000, 'revocation notice');
    expect(doomed.received.find((m) => m.name === 'access.revoked')?.payload).toEqual({
      boardId: B.id,
    });

    await edit('after removal');
    await waitFor(() => watcher.received.filter((m) => m.name === 'card.created').length >= 2);
    await sleep(300);
    expect(namesOf(doomed).filter((n) => n.startsWith('card.'))).toEqual([]); // nothing after the removal
    await waitFor(
      () => !watcher.presence().some((p) => p.user.id === member.id),
      3_000,
      'removed member left presence',
    );

    expect(await join(doomed, B.id)).toEqual({ ok: false, error: 'not_found' }); // cannot come back either
  });

  it('is noticed even if the removal notification is lost, on the next heartbeat', async () => {
    const member = await registerUser(one.url, 'silent');
    const W = await makeWorkspace([
      { user: alice, role: 'owner' },
      { user: member, role: 'viewer' },
    ]);
    const B = await makeBoard(W.id);
    const doomed = await open(two, member);
    await join(doomed, B.id);
    // remove directly in the database: no Redis notification is published at all
    await testDb()
      .db.delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, W.id), eq(workspaceMembers.userId, member.id)));
    doomed.socket.emit('presence.heartbeat', { boardId: B.id });
    await waitFor(
      () => namesOf(doomed).includes('access.revoked'),
      3_000,
      'revocation from heartbeat',
    );
    await call(
      `${one.url}/boards/${B.id}/cards`,
      asJson(alice, 'POST', { columnId: B.columnIds[0], title: 'secret' }),
    );
    await sleep(300);
    expect(namesOf(doomed).filter((n) => n.startsWith('card.'))).toEqual([]);
  });

  it('losing editor rights ends the ability to announce editing, without leaving the board', async () => {
    const member = await registerUser(one.url, 'demoted');
    const W = await makeWorkspace([
      { user: alice, role: 'owner' },
      { user: member, role: 'editor' },
    ]);
    const B = await makeBoard(W.id);
    const card = cardSchema.parse(
      (
        await call(
          `${one.url}/boards/${B.id}/cards`,
          asJson(alice, 'POST', { columnId: B.columnIds[0], title: 'c' }),
        )
      ).body,
    );
    const watcher = await open(one, alice);
    const demoted = await open(two, member);
    await Promise.all([join(watcher, B.id), join(demoted, B.id)]);

    await call(
      `${one.url}/workspaces/${W.id}/members/${member.id}`,
      asJson(alice, 'PATCH', { role: 'viewer' }),
    );
    demoted.socket.emit('presence.editing', { boardId: B.id, cardId: card.id });
    await sleep(500);
    expect(
      watcher.presence().find((p) => p.user.id === member.id)?.editingCardId ?? null,
    ).toBeNull();
    expect(namesOf(demoted)).not.toContain('access.revoked'); // a viewer may still watch
  });
});

describe('abuse', () => {
  it('a flood is dropped and then disconnected, while everyone else is unaffected', async () => {
    const calm = await open(one, alice);
    const noisy = await open(two, bob);
    await Promise.all([join(calm), join(noisy)]);
    await sleep(500);
    const before = calm.received.filter((m) => m.name === 'presence.snapshot').length;

    const closed = new Promise<string>((resolve) => noisy.socket.once('disconnect', resolve));
    for (let i = 0; i < 1_000; i += 1)
      noisy.socket.emit('presence.editing', { boardId: board.id, cardId: null });
    expect(await Promise.race([closed, sleep(8_000).then(() => 'still connected')])).toBe(
      'io server disconnect',
    );

    const broadcasts = calm.received.filter((m) => m.name === 'presence.snapshot').length - before;
    expect(broadcasts).toBeLessThan(150); // far fewer than the 1000 sent: the rest were dropped
    expect((await call(`${one.url}/health`)).status).toBe(200);
    expect(calm.socket.connected).toBe(true);
    await waitFor(
      () => !calm.presence().some((p) => p.user.id === bob.id),
      5_000,
      'flooder removed from presence',
    );
  });

  it('leaves no ghost behind when a client disconnects while its messages are still being processed', async () => {
    const watcher = await open(one, alice);
    await join(watcher);
    for (let round = 0; round < 15; round += 1) {
      const rude = await open(two, bob);
      await join(rude);
      for (let i = 0; i < 10; i += 1)
        rude.socket.emit('presence.editing', { boardId: board.id, cardId: null });
      rude.socket.emit('presence.heartbeat', { boardId: board.id });
      rude.socket.disconnect(); // gone before the server has finished handling the messages above
      await sleep(30);
    }
    // Nothing may linger: not for the 6 seconds a ghost would take to expire on its own.
    await waitFor(
      () => !watcher.presence().some((p) => p.user.id === bob.id),
      1_500,
      'no ghost of bob',
    );
    await sleep(500);
    expect(watcher.presence().map((p) => p.user.id)).toEqual([alice.id]);
    expect(await redis.zcard(`presence:${board.id}`)).toBe(1); // only alice's connection is left in Redis
  });

  it('an oversized message closes the connection', async () => {
    const client = await open(one, alice);
    await join(client);
    const closed = new Promise<string>((resolve) => client.socket.once('disconnect', resolve));
    client.socket.emit('presence.editing', {
      boardId: board.id,
      cardId: null,
      junk: 'x'.repeat(200_000),
    });
    expect(await Promise.race([closed, sleep(5_000).then(() => 'still connected')])).not.toBe(
      'still connected',
    );
  });

  it('a normal burst of activity is not mistaken for a flood', async () => {
    const client = await open(one, alice);
    await join(client);
    for (let i = 0; i < 20; i += 1) client.socket.emit('presence.heartbeat', { boardId: board.id });
    await sleep(500);
    expect(client.socket.connected).toBe(true);
  });
});
