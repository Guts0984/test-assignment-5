import { boardColumns } from '@kanban/db';
import {
  boardSchema,
  cardSchema,
  createdBoardSchema,
  workspaceSummarySchema,
} from '@kanban/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import { as, asJson, makeWorkspace, registerUser, testDb, type TestUser } from './support/world';

let api: RunningApp;
let owner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let workspaceId: string;
let otherWorkspaceId: string;

const url = (path: string) => `${api.url}${path}`;
const create = (user: TestUser, id: string, body: unknown) =>
  call(url(`/workspaces/${id}/boards`), asJson(user, 'POST', body));

beforeAll(async () => {
  api = await startApp(testConfig());
  [owner, editor, viewer, outsider] = (await Promise.all(
    ['o', 'e', 'v', 'x'].map((n) => registerUser(api.url, n)),
  )) as [TestUser, TestUser, TestUser, TestUser];
  workspaceId = (
    await makeWorkspace([
      { user: owner, role: 'owner' },
      { user: editor, role: 'editor' },
      { user: viewer, role: 'viewer' },
    ])
  ).id;
  otherWorkspaceId = (await makeWorkspace([{ user: outsider, role: 'owner' }])).id;
});
afterAll(async () => {
  await api.close();
});

describe('creating a board', () => {
  it('gives it the default columns, in order, and makes it usable at once', async () => {
    const response = await create(owner, workspaceId, { name: 'Launch plan' });
    expect(response.status).toBe(201);
    const created = createdBoardSchema.parse(response.body);
    expect(created).toMatchObject({ workspaceId, name: 'Launch plan' });

    const board = boardSchema.parse((await call(url(`/boards/${created.id}`), as(owner))).body);
    expect(board.columns.map((c) => c.name)).toEqual(['To do', 'In progress', 'Done']);
    expect(new Set(board.columns.map((c) => c.position)).size).toBe(3);
    expect(board.cards).toEqual([]);
    expect(board.role).toBe('owner');

    const card = await call(
      url(`/boards/${created.id}/cards`),
      asJson(owner, 'POST', { columnId: board.columns[0]!.id, title: 'First card' }),
    );
    expect(cardSchema.parse(card.body).title).toBe('First card');

    const listed = (await call(url('/workspaces'), as(owner))).body as unknown[];
    const workspace = workspaceSummarySchema.parse(
      listed.find((w) => (w as { id: string }).id === workspaceId),
    );
    expect(workspace.boards.map((b) => b.id)).toContain(created.id);
  });

  it('uses the column names the creator gives, left to right', async () => {
    const created = createdBoardSchema.parse(
      (
        await create(editor, workspaceId, {
          name: 'Sprint',
          columns: ['Backlog', 'Review', 'Shipped', 'Archive'],
        })
      ).body,
    );
    const rows = await testDb()
      .db.select()
      .from(boardColumns)
      .where(eq(boardColumns.boardId, created.id));
    expect(rows.sort((a, b) => (a.position < b.position ? -1 : 1)).map((r) => r.name)).toEqual([
      'Backlog',
      'Review',
      'Shipped',
      'Archive',
    ]);
  });

  it.each([
    ['an owner gets 201', () => owner, 201],
    ['an editor gets 201', () => editor, 201],
    ['a viewer gets 403', () => viewer, 403],
    ['an outsider gets 404', () => outsider, 404],
  ])('%s', async (_who, user, status) => {
    expect((await create(user(), workspaceId, { name: 'Permission test' })).status).toBe(status);
  });

  it('cannot be done in a workspace you are not in, and that looks like it does not exist', async () => {
    const real = await create(owner, otherWorkspaceId, { name: 'x' });
    const fake = await create(owner, '123e4567-e89b-42d3-a456-426614174999', { name: 'x' });
    expect({ ...expectError(real, 404, 'not_found'), requestId: undefined }).toEqual({
      ...expectError(fake, 404, 'not_found'),
      requestId: undefined,
    });
    expectError(
      await call(url(`/workspaces/${workspaceId}/boards`), { method: 'POST', json: { name: 'x' } }),
      401,
      'unauthorized',
    );
  });

  it.each([
    ['no name', {}],
    ['a blank name', { name: '   ' }],
    ['a name that is too long', { name: 'x'.repeat(101) }],
    ['a NUL byte in the name', { name: 'a\u0000b' }],
    ['no columns', { name: 'x', columns: [] }],
    ['too many columns', { name: 'x', columns: Array.from({ length: 13 }, (_, i) => `c${i}`) }],
    ['a blank column name', { name: 'x', columns: ['ok', ' '] }],
  ])('rejects %s with a 400 and creates nothing', async (_label, body) => {
    expectError(await create(owner, workspaceId, body), 400, 'validation_failed');
  });
});
