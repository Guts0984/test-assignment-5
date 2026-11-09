import { boards, cards } from '@kanban/db';
import {
  boardSchema,
  cardSchema,
  createdBoardSchema,
  workspaceSummarySchema,
} from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  expectError as expectErrorCode,
  startApp,
  testConfig,
  type RunningApp,
} from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

const DEFAULT_CODE = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
} as const;
const expectError = (
  response: { status: number; body: unknown },
  status: keyof typeof DEFAULT_CODE,
  code: (typeof DEFAULT_CODE)[keyof typeof DEFAULT_CODE] = DEFAULT_CODE[status],
) => expectErrorCode(response, status, code);

let api: RunningApp;
let owner: TestUser;
let editor: TestUser; // creates boards
let otherEditor: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let workspaceId: string;

const url = (path: string) => `${api.url}${path}`;
const rename = (user: TestUser, id: string, body: unknown) =>
  call(url(`/boards/${id}`), asJson(user, 'PATCH', body));
const remove = (user: TestUser, id: string) =>
  call(url(`/boards/${id}`), { method: 'DELETE', headers: as(user).headers });
const newBoard = async (user: TestUser, name = 'Board') =>
  createdBoardSchema.parse(
    (await call(url(`/workspaces/${workspaceId}/boards`), asJson(user, 'POST', { name }))).body,
  );
const getBoard = (user: TestUser, id: string) => call(url(`/boards/${id}`), as(user));
const snapshot = async (user: TestUser, id: string) =>
  boardSchema.parse((await getBoard(user, id)).body);

beforeAll(async () => {
  api = await startApp(testConfig());
  [owner, editor, otherEditor, viewer, outsider] = (await Promise.all(
    ['o', 'e', 'f', 'v', 'x'].map((n) => registerUser(api.url, n)),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  workspaceId = (
    await makeWorkspace([
      { user: owner, role: 'owner' },
      { user: editor, role: 'editor' },
      { user: otherEditor, role: 'editor' },
      { user: viewer, role: 'viewer' },
    ])
  ).id;
});
afterAll(async () => {
  await api.close();
});

describe('who may rename a board', () => {
  it('the workspace owner may rename any board, and the new name is what everyone sees', async () => {
    const board = await newBoard(editor, 'Old name');
    const response = await rename(owner, board.id, { name: '  New name ' });
    expect(response.status).toBe(200);
    expect(createdBoardSchema.parse(response.body).name).toBe('New name');
    expect((await snapshot(viewer, board.id)).board.name).toBe('New name');
    const listed = workspaceSummarySchema
      .array()
      .parse((await call(url('/workspaces'), as(viewer))).body);
    expect(listed.flatMap((w) => w.boards).find((b) => b.id === board.id)?.name).toBe('New name');
  });

  it('the creator (an editor) may rename their own board but not a colleague’s', async () => {
    const mine = await newBoard(editor, 'Mine');
    const theirs = await newBoard(otherEditor, 'Theirs');
    expect((await rename(editor, mine.id, { name: 'Mine 2' })).status).toBe(200);
    expectError(await rename(editor, theirs.id, { name: 'Hijack' }), 403, 'forbidden');
    expect((await snapshot(owner, theirs.id)).board.name).toBe('Theirs');
  });

  it('a viewer may not, even if they somehow created it before being demoted', async () => {
    const board = await newBoard(editor, 'Guarded');
    expectError(await rename(viewer, board.id, { name: 'x' }), 403, 'forbidden');
    // the creator, once demoted to viewer, loses the right with the role
    const { workspaceMembers } = await import('@kanban/db');
    const { and } = await import('drizzle-orm');
    await testDb()
      .db.update(workspaceMembers)
      .set({ role: 'viewer' })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, otherEditor.id),
        ),
      );
    const demoted = await newBoardDirect(otherEditor.id);
    expectError(await rename(otherEditor, demoted, { name: 'x' }), 403, 'forbidden');
    await testDb()
      .db.update(workspaceMembers)
      .set({ role: 'editor' })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, otherEditor.id),
        ),
      );
  });

  it('outsiders and strangers get 404, never 403, and nothing changes', async () => {
    const board = await newBoard(owner, 'Secret');
    expectError(await rename(outsider, board.id, { name: 'x' }), 404, 'not_found');
    expectError(await rename(owner, '00000000-0000-4000-8000-000000000000', { name: 'x' }), 404);
    expect((await snapshot(owner, board.id)).board.name).toBe('Secret');
  });

  it.each([
    ['empty', { name: '' }],
    ['blank', { name: '  ' }],
    ['too long', { name: 'x'.repeat(101) }],
    ['NUL', { name: 'a\u0000' }],
    ['missing', {}],
    ['wrong type', { name: ['a'] }],
  ])('rejects a %s name with 400', async (_label, body) => {
    const board = await newBoard(owner, 'Stable');
    expectError(await rename(owner, board.id, body), 400);
    expect((await snapshot(owner, board.id)).board.name).toBe('Stable');
  });

  it('rejects a malformed id with 400 and needs a session', async () => {
    expectError(await rename(owner, 'not-an-id', { name: 'x' }), 400);
    const board = await newBoard(owner);
    expectError(
      await call(url(`/boards/${board.id}`), { method: 'PATCH', json: { name: 'x' } }),
      401,
    );
  });
});

describe('who may delete a board', () => {
  it('the owner can; afterwards the board is gone for everyone, in every endpoint', async () => {
    const board = await newBoard(editor, 'Doomed');
    const full = await snapshot(owner, board.id);
    const card = cardSchema.parse(
      (
        await call(
          url(`/boards/${board.id}/cards`),
          asJson(owner, 'POST', { columnId: full.columns[0]!.id, title: 'zebracorn plan' }),
        )
      ).body,
    );

    const response = await remove(owner, board.id);
    expect(response.status).toBe(204);

    for (const user of [owner, editor, viewer]) {
      expectError(await getBoard(user, board.id), 404, 'not_found');
      expectError(await call(url(`/boards/${board.id}/activity`), as(user)), 404, 'not_found');
      expectError(
        await call(
          url(`/boards/${board.id}/cards`),
          asJson(user, 'POST', { columnId: full.columns[0]!.id, title: 'x' }),
        ),
        404,
      );
      expectError(await call(url(`/cards/${card.id}/comments`), as(user)), 404, 'not_found');
      expectError(
        await call(url(`/cards/${card.id}`), asJson(user, 'PATCH', { version: 1, title: 'x' })),
        404,
      );
    }
    const listed = workspaceSummarySchema
      .array()
      .parse((await call(url('/workspaces'), as(owner))).body);
    expect(listed.flatMap((w) => w.boards).map((b) => b.id)).not.toContain(board.id);

    const found = await call(url(`/search?q=zebracorn&workspace=${workspaceId}`), as(owner));
    expect(JSON.stringify(found.body)).not.toContain('zebracorn');

    // history is kept, but marked deleted
    const [row] = await testDb().db.select().from(boards).where(eq(boards.id, board.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    const [cardRow] = await testDb().db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardRow?.deletedAt).toBeInstanceOf(Date);
  });

  it('files of its cards are left for the worker: the cards are marked deleted', async () => {
    const board = await newBoard(owner, 'With files');
    const full = await snapshot(owner, board.id);
    await call(
      url(`/boards/${board.id}/cards`),
      asJson(owner, 'POST', { columnId: full.columns[0]!.id, title: 'a' }),
    );
    await call(
      url(`/boards/${board.id}/cards`),
      asJson(owner, 'POST', { columnId: full.columns[1]!.id, title: 'b' }),
    );
    await remove(owner, board.id);
    const live = await testDb().db.select().from(cards).where(eq(cards.boardId, board.id));
    expect(live).toHaveLength(2);
    expect(live.every((c) => c.deletedAt !== null)).toBe(true);
  });

  it('the creator can delete their own board, but not a colleague’s', async () => {
    const mine = await newBoard(editor);
    const theirs = await newBoard(otherEditor);
    expect((await remove(editor, mine.id)).status).toBe(204);
    expectError(await remove(editor, theirs.id), 403, 'forbidden');
    expect((await getBoard(owner, theirs.id)).status).toBe(200);
  });

  it('a viewer cannot, an outsider gets 404, and a second delete is 404', async () => {
    const board = await newBoard(owner);
    expectError(await remove(viewer, board.id), 403, 'forbidden');
    expectError(await remove(outsider, board.id), 404, 'not_found');
    expect((await getBoard(owner, board.id)).status).toBe(200);
    expect((await remove(owner, board.id)).status).toBe(204);
    expectError(await remove(owner, board.id), 404, 'not_found');
    expectError(await rename(owner, board.id, { name: 'back' }), 404, 'not_found');
  });

  it('deleting one board leaves the other boards of the workspace untouched', async () => {
    const keep = await newBoard(owner, 'Keep');
    const keepFull = await snapshot(owner, keep.id);
    await call(
      url(`/boards/${keep.id}/cards`),
      asJson(owner, 'POST', { columnId: keepFull.columns[0]!.id, title: 'survivor' }),
    );
    const drop = await newBoard(owner, 'Drop');
    await remove(owner, drop.id);
    expect((await snapshot(owner, keep.id)).cards.map((c) => c.title)).toEqual(['survivor']);
  });

  it('a malformed id is 400, no session is 401', async () => {
    expectError(await remove(owner, 'nope'), 400);
    const board = await newBoard(owner);
    expectError(await call(url(`/boards/${board.id}`), { method: 'DELETE' }), 401);
  });
});

describe('what the board says about the caller', () => {
  it('canManage is true for the owner and the creator-editor only', async () => {
    const board = await newBoard(editor);
    expect((await snapshot(owner, board.id)).board.canManage).toBe(true);
    expect((await snapshot(editor, board.id)).board.canManage).toBe(true);
    expect((await snapshot(otherEditor, board.id)).board.canManage).toBe(false);
    expect((await snapshot(viewer, board.id)).board.canManage).toBe(false);
  });

  it('boards without a recorded creator can be managed by owners only', async () => {
    const { makeBoard } = await import('./support/world');
    const old = await makeBoard(workspaceId);
    expect((await snapshot(owner, old.id)).board.canManage).toBe(true);
    expect((await snapshot(editor, old.id)).board.canManage).toBe(false);
    expectError(await rename(editor, old.id, { name: 'x' }), 403, 'forbidden');
  });
});

const newBoardDirect = async (createdBy: string): Promise<string> => {
  const [row] = await testDb()
    .db.insert(boards)
    .values({ workspaceId, name: 'direct', createdBy })
    .returning({ id: boards.id });
  if (!row) throw new Error('insert failed');
  return row.id;
};
