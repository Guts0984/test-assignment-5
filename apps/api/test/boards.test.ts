import { activityLog, cards } from '@kanban/db';
import {
  activityEntrySchema,
  boardSchema,
  cardSchema,
  moveCardResponseSchema,
  versionConflictDetailsSchema,
  type Card,
  type ServerEventName,
} from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BoardEvents } from '../src/realtime/board-events';
import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import {
  as,
  asJson,
  makeBoard,
  makeWorkspace,
  registerUser,
  testDb,
  type TestUser,
} from './support/world';

let api: RunningApp;
let alice: TestUser; // owner of A
let bob: TestUser; // editor of A
let carol: TestUser; // viewer of A
let dave: TestUser; // owner of B (cannot see A)
let eve: TestUser; // member of nothing
let workspaceId: string;
let board: { id: string; columnIds: string[] };
let events: { name: ServerEventName; payload: Record<string, unknown> }[];

const url = (path: string) => `${api.url}${path}`;
const [TODO, DOING, DONE] = [0, 1, 2] as const;
const NOWHERE = '123e4567-e89b-42d3-a456-426614174999';

beforeAll(async () => {
  api = await startApp(testConfig());
  const users = await Promise.all(
    ['alice', 'bob', 'carol', 'dave', 'eve'].map((n) => registerUser(api.url, n)),
  );
  [alice, bob, carol, dave, eve] = users as [TestUser, TestUser, TestUser, TestUser, TestUser];
  ({ id: workspaceId } = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: bob, role: 'editor' },
    { user: carol, role: 'viewer' },
  ]));
  await makeWorkspace([{ user: dave, role: 'owner' }]);
  board = await makeBoard(workspaceId);

  events = [];
  api.app
    .get(BoardEvents)
    .setSink((_room, name, payload) =>
      events.push({ name: name as ServerEventName, payload: payload as Record<string, unknown> }),
    );
});

afterAll(async () => {
  await api.close();
});

const col = (i: number) => board.columnIds[i] as string;

const createCard = async (
  user: TestUser,
  title: string,
  extra: Record<string, unknown> = {},
  boardId = board.id,
) =>
  call(
    url(`/boards/${boardId}/cards`),
    asJson(user, 'POST', { columnId: col(TODO), title, ...extra }),
  );

const newCard = async (title = 'card', extra: Record<string, unknown> = {}) => {
  const response = await createCard(alice, title, extra);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return cardSchema.parse(response.body);
};

const getBoard = async (user: TestUser = alice, boardId = board.id) =>
  boardSchema.parse((await call(url(`/boards/${boardId}`), as(user))).body);

const idsIn = (snapshot: { cards: Card[] }, columnId: string) =>
  snapshot.cards.filter((c) => c.columnId === columnId).map((c) => c.id);

describe('reading a board', () => {
  it('returns columns and cards in display order, with the reader’s role', async () => {
    const first = await newCard('first');
    const second = await newCard('second', { afterId: first.id });
    const third = await newCard('third', { beforeId: first.id });

    for (const [user, role] of [
      [alice, 'owner'],
      [bob, 'editor'],
      [carol, 'viewer'],
    ] as const) {
      const snapshot = await getBoard(user);
      expect(snapshot.role).toBe(role);
      expect(snapshot.columns.map((c) => c.id)).toEqual(board.columnIds);
      const order = idsIn(snapshot, col(TODO));
      expect(order.indexOf(third.id)).toBeLessThan(order.indexOf(first.id));
      expect(order.indexOf(first.id)).toBeLessThan(order.indexOf(second.id));
    }
  });

  it('leaves out deleted cards', async () => {
    const card = await newCard('to delete');
    await call(url(`/cards/${card.id}`), { method: 'DELETE', ...as(alice) });
    expect(idsIn(await getBoard(), col(TODO))).not.toContain(card.id);
  });

  it('is a 404 for outsiders, identical to a board that does not exist', async () => {
    const real = await call(url(`/boards/${board.id}`), as(eve));
    const fake = await call(url(`/boards/${NOWHERE}`), as(eve));
    expect({ ...expectError(real, 404, 'not_found'), requestId: undefined }).toEqual({
      ...expectError(fake, 404, 'not_found'),
      requestId: undefined,
    });
    expectError(await call(url(`/boards/${board.id}`), as(dave)), 404, 'not_found');
    expectError(await call(url(`/boards/${board.id}`)), 401, 'unauthorized');
    expectError(await call(url('/boards/not-an-id'), as(alice)), 400, 'validation_failed');
  });
});

describe('creating cards', () => {
  it('is allowed for editors and owners, with the card placed where asked', async () => {
    const anchor = await newCard('anchor');
    const created = cardSchema.parse(
      (await createCard(bob, 'by bob', { afterId: anchor.id })).body,
    );
    expect(created).toMatchObject({
      title: 'by bob',
      description: '',
      version: 1,
      createdBy: bob.id,
      columnId: col(TODO),
    });
    const order = idsIn(await getBoard(), col(TODO));
    expect(order[order.indexOf(anchor.id) + 1]).toBe(created.id);
  });

  it.each([
    ['a viewer', () => carol, 403],
    ['an outsider', () => eve, 404],
    ['the owner of another workspace', () => dave, 404],
  ])('is refused for %s and leaves no card behind', async (_who, user, status) => {
    const before = (await getBoard()).cards.length;
    expect((await createCard(user(), 'forbidden')).status).toBe(status);
    expect((await getBoard()).cards.length).toBe(before);
  });

  it('rejects a column that is not on this board, and invalid input', async () => {
    const otherBoard = await makeBoard(workspaceId);
    expectError(
      await createCard(alice, 'x', { columnId: otherBoard.columnIds[0] }),
      404,
      'not_found',
    );
    expectError(await createCard(alice, 'x', { columnId: NOWHERE }), 404, 'not_found');
    expectError(await createCard(alice, ''), 400, 'validation_failed');
    expectError(await createCard(alice, 'x'.repeat(201)), 400, 'validation_failed');
    expectError(await createCard(alice, 'a\u0000b'), 400, 'validation_failed');
    expectError(await createCard(alice, 'x', { afterId: 'not-an-id' }), 400, 'validation_failed');
  });
});

describe('editing cards (version check)', () => {
  const patch = (user: TestUser, cardId: string, body: Record<string, unknown>) =>
    call(url(`/cards/${cardId}`), asJson(user, 'PATCH', body));

  it('increments the version, and a stale version gets a 409 carrying the winning card', async () => {
    const card = await newCard('original');
    const first = await patch(alice, card.id, { version: 1, title: 'alice was first' });
    expect(cardSchema.parse(first.body)).toMatchObject({ title: 'alice was first', version: 2 });

    const stale = await patch(bob, card.id, {
      version: 1,
      title: 'bob was slower',
      description: 'bob wrote this',
    });
    const error = expectError(stale, 409, 'version_conflict');
    expect(versionConflictDetailsSchema.parse(error.details).current).toMatchObject({
      title: 'alice was first',
      version: 2,
    });

    const stored = (await getBoard()).cards.find((c) => c.id === card.id);
    expect(stored).toMatchObject({ title: 'alice was first', description: '', version: 2 }); // bob's text was NOT applied
  });

  it('of two edits made from the same version exactly one wins', async () => {
    for (let round = 0; round < 5; round += 1) {
      const card = await newCard(`race ${round}`);
      const results = await Promise.all([
        patch(alice, card.id, { version: 1, title: 'from alice' }),
        patch(bob, card.id, { version: 1, title: 'from bob' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const [row] = await testDb().db.select().from(cards).where(eq(cards.id, card.id));
      expect(row?.version).toBe(2);
    }
  });

  it('changes only title and description, whatever else the request contains', async () => {
    const card = await newCard('safe');
    await patch(alice, card.id, {
      version: 1,
      title: 'new',
      columnId: col(DONE),
      position: 'zzz',
      createdBy: bob.id,
      version2: 9,
    });
    const stored = (await getBoard()).cards.find((c) => c.id === card.id);
    expect(stored).toMatchObject({
      title: 'new',
      columnId: col(TODO),
      position: card.position,
      createdBy: alice.id,
    });
  });

  it.each([
    ['a viewer', () => carol, 403],
    ['an outsider', () => eve, 404],
    ['the owner of another workspace', () => dave, 404],
  ])('is refused for %s', async (_who, user, status) => {
    const card = await newCard('protected');
    expect((await patch(user(), card.id, { version: 1, title: 'hacked' })).status).toBe(status);
    expect((await getBoard()).cards.find((c) => c.id === card.id)?.title).toBe('protected');
  });

  it('rejects incomplete or invalid edits, and edits of cards that do not exist', async () => {
    const card = await newCard('valid');
    expectError(await patch(alice, card.id, { title: 'no version' }), 400, 'validation_failed');
    expectError(await patch(alice, card.id, { version: 1 }), 400, 'validation_failed');
    expectError(await patch(alice, card.id, { version: 1, title: '' }), 400, 'validation_failed');
    expectError(
      await patch(alice, card.id, { version: 1, description: 'a\u0000b' }),
      400,
      'validation_failed',
    );
    expectError(await patch(alice, NOWHERE, { version: 1, title: 'x' }), 404, 'not_found');
  });

  it('cannot revive a deleted card', async () => {
    const card = await newCard('doomed');
    await call(url(`/cards/${card.id}`), { method: 'DELETE', ...as(alice) });
    expectError(await patch(alice, card.id, { version: 1, title: 'zombie' }), 404, 'not_found');
  });
});

describe('deleting cards', () => {
  const remove = (user: TestUser, cardId: string) =>
    call(url(`/cards/${cardId}`), { method: 'DELETE', ...as(user) });

  it('works once for editors; the card is soft-deleted and gone for everyone', async () => {
    const card = await newCard('bye');
    expect((await remove(bob, card.id)).status).toBe(204);
    expectError(await remove(bob, card.id), 404, 'not_found');
    const [row] = await testDb().db.select().from(cards).where(eq(cards.id, card.id));
    expect(row?.deletedAt).not.toBeNull(); // kept so the worker can remove its files
  });

  it.each([
    ['a viewer', () => carol, 403],
    ['an outsider', () => eve, 404],
    ['the owner of another workspace', () => dave, 404],
  ])('is refused for %s', async (_who, user, status) => {
    const card = await newCard('keep me');
    expect((await remove(user(), card.id)).status).toBe(status);
    expect(idsIn(await getBoard(), col(TODO))).toContain(card.id);
  });
});

describe('moving cards', () => {
  const move = (user: TestUser, cardId: string, body: Record<string, unknown>) =>
    call(url(`/cards/${cardId}/move`), asJson(user, 'POST', body));

  it('places a card between neighbours, across columns, without changing its version', async () => {
    const a = await newCard('a');
    const b = await newCard('b', { afterId: a.id });
    const mover = await newCard('mover');

    const response = await move(bob, mover.id, {
      columnId: col(TODO),
      afterId: a.id,
      beforeId: b.id,
    });
    const result = moveCardResponseSchema.parse(response.body);
    expect(result).toMatchObject({ fromColumnId: col(TODO), rebalanced: false });
    expect(result.card.version).toBe(1);
    const order = idsIn(await getBoard(), col(TODO));
    expect(order.indexOf(mover.id)).toBe(order.indexOf(a.id) + 1);
    expect(order.indexOf(b.id)).toBe(order.indexOf(mover.id) + 1);

    const other = moveCardResponseSchema.parse(
      (await move(alice, mover.id, { columnId: col(DOING) })).body,
    );
    expect(other).toMatchObject({ fromColumnId: col(TODO) });
    expect(idsIn(await getBoard(), col(DOING))).toContain(mover.id);
    expect(idsIn(await getBoard(), col(TODO))).not.toContain(mover.id);
  });

  it('a viewer cannot move, and nothing changes', async () => {
    const card = await newCard('still');
    const before = await getBoard();
    expectError(await move(carol, card.id, { columnId: col(DONE) }), 403, 'forbidden');
    expect(await getBoard()).toEqual(before);
  });

  it('foreign ids all look like nothing exists', async () => {
    const card = await newCard('mine');
    for (const user of [eve, dave]) {
      expectError(await move(user, card.id, { columnId: col(DONE) }), 404, 'not_found');
    }
    const foreign = await makeBoard(workspaceId);
    expectError(
      await move(alice, card.id, { columnId: foreign.columnIds[0] ?? '' }),
      404,
      'not_found',
    ); // column of another board
    expectError(await move(alice, NOWHERE, { columnId: col(DONE) }), 404, 'not_found');
    expectError(await move(alice, card.id, { columnId: 'nope' }), 400, 'validation_failed');
    expect(idsIn(await getBoard(), col(TODO))).toContain(card.id);
  });

  it('moving next to a neighbour that has since moved or been deleted still works', async () => {
    const anchor = await newCard('anchor');
    const mover = await newCard('mover');
    await move(alice, anchor.id, { columnId: col(DONE) }); // the anchor leaves the column
    const response = await move(bob, mover.id, { columnId: col(TODO), afterId: anchor.id });
    expect(response.status).toBe(200);
    await call(url(`/cards/${anchor.id}`), { method: 'DELETE', ...as(alice) });
    expect((await move(bob, mover.id, { columnId: col(TODO), beforeId: anchor.id })).status).toBe(
      200,
    );
  });

  it('two people making 50 random moves each at the same time end with one agreed order, equal to the database', async () => {
    const created: Card[] = [];
    for (let i = 0; i < 12; i += 1) created.push(await newCard(`shuffle ${i}`));
    const ids = created.map((c) => c.id);
    const pick = (n: number) =>
      ids[Math.floor(Math.abs(Math.sin(n) * 10_000)) % ids.length] as string;

    const requests = Array.from({ length: 100 }, (_, i) => {
      const user = i % 2 === 0 ? alice : bob;
      return move(user, pick(i * 3 + 1), {
        columnId: col(i % 7 === 0 ? DOING : TODO),
        afterId: pick(i * 5 + 2),
        beforeId: pick(i * 11 + 3),
      });
    });
    const responses = await Promise.all(requests);
    expect(
      responses.every((r) => r.status === 200),
      JSON.stringify(responses.find((r) => r.status !== 200)?.body),
    ).toBe(true);

    const seenByAlice = await getBoard(alice);
    const seenByBob = await getBoard(bob);
    expect(seenByAlice.cards).toEqual(seenByBob.cards);
    for (const columnId of [col(TODO), col(DOING)]) {
      const fromDb = (
        await testDb().db.select().from(cards).where(eq(cards.columnId, columnId))
      ).filter((c) => !c.deletedAt && ids.includes(c.id));
      fromDb.sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
      );
      const shown = seenByAlice.cards
        .filter((c) => c.columnId === columnId && ids.includes(c.id))
        .map((c) => c.id);
      expect(shown).toEqual(fromDb.map((c) => c.id));
      expect(new Set(fromDb.map((c) => c.position)).size).toBe(fromDb.length);
    }
    expect(ids.every((id) => seenByAlice.cards.some((c) => c.id === id))).toBe(true); // nothing lost
  });
});

describe('activity log', () => {
  it('records every change in order, newest first, and pages through them with a cursor', async () => {
    const quiet = await makeBoard(workspaceId);
    const card = cardSchema.parse(
      (await createCard(alice, 'logged', { columnId: quiet.columnIds[0] }, quiet.id)).body,
    );
    await call(url(`/cards/${card.id}`), asJson(bob, 'PATCH', { version: 1, title: 'renamed' }));
    await call(
      url(`/cards/${card.id}/move`),
      asJson(alice, 'POST', { columnId: quiet.columnIds[1] }),
    );
    await call(url(`/cards/${card.id}`), { method: 'DELETE', ...as(alice) });

    const all = await call(url(`/boards/${quiet.id}/activity`), as(carol)); // viewers may read it
    const page = all.body as { items: unknown[]; nextCursor: string | null };
    const entries = page.items.map((item) => activityEntrySchema.parse(item));
    expect(entries.map((e) => e.type)).toEqual([
      'card.deleted',
      'card.moved',
      'card.updated',
      'card.created',
    ]);
    expect(entries.map((e) => e.actor?.id)).toEqual([alice.id, alice.id, bob.id, alice.id]);
    expect(page.nextCursor).toBeNull();

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const next: { items: { id: number }[]; nextCursor: string | null } = (
        await call(
          url(`/boards/${quiet.id}/activity?limit=3${cursor ? `&cursor=${cursor}` : ''}`),
          as(alice),
        )
      ).body as never;
      seen.push(...next.items.map((e) => e.id));
      cursor = next.nextCursor;
    } while (cursor);
    expect(seen).toEqual(entries.map((e) => e.id)); // complete, no duplicates, same order
  });

  it('is only readable by members, and a cursor cannot be used to peek at another board', async () => {
    const mine = await makeBoard(workspaceId);
    await createCard(alice, 'mine', { columnId: mine.columnIds[0] }, mine.id);
    const theirs = await makeBoard((await makeWorkspace([{ user: dave, role: 'owner' }])).id);
    const [row] = await testDb()
      .db.select()
      .from(activityLog)
      .where(eq(activityLog.boardId, mine.id));

    expectError(await call(url(`/boards/${mine.id}/activity`), as(eve)), 404, 'not_found');
    expectError(await call(url(`/boards/${mine.id}/activity`), as(dave)), 404, 'not_found');
    // dave's own board with a cursor just above alice's entry: only dave's board's entries can appear
    const cursor = Buffer.from(String((row?.id ?? 0) + 1)).toString('base64url');
    const peek = await call(url(`/boards/${theirs.id}/activity?cursor=${cursor}`), as(dave));
    expect((peek.body as { items: { entityId: string }[] }).items).toEqual([]);
  });

  it('rejects broken cursors and limits instead of failing', async () => {
    for (const q of [
      'cursor=garbage',
      'cursor=%00',
      'cursor=',
      'limit=0',
      'limit=101',
      'limit=abc',
    ]) {
      expectError(
        await call(url(`/boards/${board.id}/activity?${q}`), as(alice)),
        400,
        'validation_failed',
      );
    }
  });
});

describe('realtime announcements', () => {
  it('are emitted once per accepted change, in order, with the sender’s mutation id, and never for refused ones', async () => {
    events.length = 0;
    const created = cardSchema.parse(
      (await createCard(alice, 'announced', { clientMutationId: 'mut-1' })).body,
    );
    await call(
      url(`/cards/${created.id}`),
      asJson(bob, 'PATCH', { version: 1, title: 'x', clientMutationId: 'mut-2' }),
    );
    await call(
      url(`/cards/${created.id}/move`),
      asJson(alice, 'POST', { columnId: col(DOING), clientMutationId: 'mut-3' }),
    );
    await call(
      url(`/cards/${created.id}/move`),
      asJson(carol, 'POST', { columnId: col(DONE), clientMutationId: 'mut-refused' }),
    ); // viewer
    await call(
      url(`/cards/${created.id}`),
      asJson(bob, 'PATCH', { version: 1, title: 'stale', clientMutationId: 'mut-stale' }),
    ); // 409
    await call(url(`/cards/${created.id}`), { method: 'DELETE', ...as(alice) });

    expect(events.map((e) => e.name)).toEqual([
      'card.created',
      'card.updated',
      'card.moved',
      'card.deleted',
    ]);
    expect(events.map((e) => e.payload.clientMutationId)).toEqual([
      'mut-1',
      'mut-2',
      'mut-3',
      null,
    ]);
    const ids = events.map((e) => e.payload.eventId as number);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
    expect(events.every((e) => e.payload.boardId === board.id)).toBe(true);
  });
});
