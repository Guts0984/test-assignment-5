import { commentMentions } from '@kanban/db';
import { cardSchema, commentSchema, type ServerEventName } from '@kanban/shared';
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
let alice: TestUser; // owner
let bob: TestUser; // editor
let carol: TestUser; // viewer
let dave: TestUser; // owner of another workspace
let eve: TestUser; // member of nothing
let board: { id: string; columnIds: string[] };
const events: { name: ServerEventName; payload: Record<string, unknown> }[] = [];

const url = (path: string) => `${api.url}${path}`;
const newCard = async (title = 'Discuss me') =>
  cardSchema.parse(
    (
      await call(
        url(`/boards/${board.id}/cards`),
        asJson(alice, 'POST', { columnId: board.columnIds[0], title }),
      )
    ).body,
  ).id;
const post = (user: TestUser, cardId: string, body: unknown) =>
  call(url(`/cards/${cardId}/comments`), asJson(user, 'POST', { body }));
const list = (user: TestUser, cardId: string) => call(url(`/cards/${cardId}/comments`), as(user));

beforeAll(async () => {
  api = await startApp(testConfig());
  const users = await Promise.all(
    ['alice', 'bob', 'carol', 'dave', 'eve'].map((n) => registerUser(api.url, n)),
  );
  [alice, bob, carol, dave, eve] = users as [TestUser, TestUser, TestUser, TestUser, TestUser];
  const workspace = await makeWorkspace([
    { user: alice, role: 'owner' },
    { user: bob, role: 'editor' },
    { user: carol, role: 'viewer' },
  ]);
  await makeWorkspace([{ user: dave, role: 'owner' }]);
  board = await makeBoard(workspace.id);
  api.app
    .get(BoardEvents)
    .setSink((_room, name, payload) =>
      events.push({ name: name as ServerEventName, payload: payload as Record<string, unknown> }),
    );
});

afterAll(async () => {
  await api.close();
});

describe('mentions', () => {
  it('resolve to workspace members only: not the author, outsiders, unknown handles, or e-mail addresses', async () => {
    const cardId = await newCard();
    const text = `Hi @${bob.handle}, @${carol.handle.toUpperCase()} and @${bob.handle} again; also @${alice.handle} (me), @${dave.handle} (other workspace), @nobody_here, write to ${eve.handle}@example.com`;
    const response = await post(alice, cardId, text);
    expect(response.status).toBe(201);
    const created = commentSchema.parse(response.body);

    expect(created.author.id).toBe(alice.id);
    expect(created.mentions.map((m) => m.handle).sort()).toEqual([bob.handle, carol.handle].sort());
    const rows = await testDb()
      .db.select()
      .from(commentMentions)
      .where(eq(commentMentions.commentId, created.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([bob.id, carol.id].sort());
    expect(rows.every((r) => r.deliveryId === null)).toBe(true); // waiting for the worker's digest
  });

  it('are absent when nobody is mentioned', async () => {
    const created = commentSchema.parse(
      (await post(bob, await newCard(), 'just an @ sign and a@b.io')).body,
    );
    expect(created.mentions).toEqual([]);
    expect(
      await testDb()
        .db.select()
        .from(commentMentions)
        .where(eq(commentMentions.commentId, created.id)),
    ).toEqual([]);
  });
});

describe('comments', () => {
  it('are listed oldest first with their author and mentions, and viewers can read them', async () => {
    const cardId = await newCard();
    await post(alice, cardId, 'first');
    await post(bob, cardId, `second for @${alice.handle}`);
    await post(alice, cardId, 'third');

    for (const reader of [alice, bob, carol]) {
      const response = await list(reader, cardId);
      const items = (response.body as unknown[]).map((c) => commentSchema.parse(c));
      expect(items.map((c) => c.body)).toEqual(['first', `second for @${alice.handle}`, 'third']);
      expect(items.map((c) => c.author.id)).toEqual([alice.id, bob.id, alice.id]);
      expect(items[1]?.mentions.map((m) => m.handle)).toEqual([alice.handle]);
    }
  });

  it('keep text exactly as written, including whitespace, markup and unicode', async () => {
    const cardId = await newCard();
    const text = '  <b>bold</b> & "quotes"\n\tline two — пример 🙂  ';
    expect(commentSchema.parse((await post(alice, cardId, text)).body).body).toBe(text);
    expect((await list(alice, cardId)).body).toMatchObject([{ body: text }]);
  });

  it.each([
    ['a viewer', () => carol, 403],
    ['an outsider', () => eve, 404],
    ['the owner of another workspace', () => dave, 404],
  ])('cannot be written by %s', async (_who, user, status) => {
    const cardId = await newCard();
    expect((await post(user(), cardId, 'let me in')).status).toBe(status);
    expect((await list(alice, cardId)).body).toEqual([]);
  });

  it('cannot be read by outsiders, and a card that does not exist looks the same', async () => {
    const cardId = await newCard();
    await post(alice, cardId, 'secret plans');
    const real = await list(eve, cardId);
    const fake = await list(eve, '123e4567-e89b-42d3-a456-426614174999');
    expect({ ...expectError(real, 404, 'not_found'), requestId: undefined }).toEqual({
      ...expectError(fake, 404, 'not_found'),
      requestId: undefined,
    });
    expectError(await list(dave, cardId), 404, 'not_found');
    expectError(await call(url(`/cards/${cardId}/comments`)), 401, 'unauthorized');
  });

  it.each([
    ['blank', '   \n '],
    ['empty', ''],
    ['too long', 'x'.repeat(5001)],
    ['containing NUL', 'a\u0000b'],
    ['not text', 42],
  ])('reject a comment that is %s', async (_label, body) => {
    expectError(await post(alice, await newCard(), body), 400, 'validation_failed');
  });

  it('are not accepted on deleted cards', async () => {
    const cardId = await newCard();
    await call(url(`/cards/${cardId}`), { method: 'DELETE', ...as(alice) });
    expectError(await post(alice, cardId, 'too late'), 404, 'not_found');
    expectError(await list(alice, cardId), 404, 'not_found');
  });

  it('are announced to the board once, after they are stored', async () => {
    const cardId = await newCard();
    events.length = 0;
    await post(carol, cardId, 'viewers are refused');
    expect(events).toEqual([]);
    const created = commentSchema.parse((await post(bob, cardId, 'hello')).body);
    expect(events.map((e) => e.name)).toEqual(['comment.created']);
    expect(events[0]?.payload).toMatchObject({ boardId: board.id, comment: { id: created.id } });
  });
});
