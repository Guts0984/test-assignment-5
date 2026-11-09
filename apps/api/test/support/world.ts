import { randomUUID } from 'node:crypto';

import {
  boardColumns,
  boards,
  createDatabase,
  evenlySpacedKeys,
  postgresUrl,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
} from '@kanban/db';
import type { WorkspaceRole } from '@kanban/shared';
import { inject } from 'vitest';

import { call } from './app';

let handle: DatabaseHandle | undefined;

/** A direct connection to the test database, for arranging and inspecting data. */
export const testDb = (): DatabaseHandle => {
  handle ??= createDatabase({ url: postgresUrl(inject('infra').postgres), maxConnections: 5 });
  return handle;
};

export type TestUser = {
  id: string;
  email: string;
  handle: string;
  name: string;
  /** Value for the Cookie header. */
  cookie: string;
};

export const PASSWORD = 'correct-horse-battery';

/** Registers a real account through the API and keeps its session cookie. */
export const registerUser = async (url: string, label = 'user'): Promise<TestUser> => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const body = {
    email: `${label}-${suffix}@example.com`,
    handle: `${label}${suffix}`,
    name: `Test ${label}`,
    password: PASSWORD,
  };
  const response = await call(`${url}/auth/register`, { method: 'POST', json: body });
  if (response.status !== 201) throw new Error(`register failed: ${JSON.stringify(response.body)}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const me = response.body as { id: string };
  return { id: me.id, email: body.email, handle: body.handle, name: body.name, cookie };
};

export const as = (user: Pick<TestUser, 'cookie'>, extra: Record<string, string> = {}) => ({
  headers: { cookie: user.cookie, ...extra },
});

export const asJson = (user: Pick<TestUser, 'cookie'>, method: string, json: unknown) => ({
  method,
  json,
  headers: { cookie: user.cookie },
});

/** Creates a workspace with the given members (directly in the database, whoever may create one through the API). */
export const makeWorkspace = async (
  members: { user: Pick<TestUser, 'id'>; role: WorkspaceRole }[],
  boardNames: string[] = [],
): Promise<{ id: string; boardIds: string[] }> => {
  const { db } = testDb();
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `WS ${randomUUID().slice(0, 6)}` })
    .returning({ id: workspaces.id });
  if (!workspace) throw new Error('workspace insert failed');
  if (members.length > 0) {
    await db
      .insert(workspaceMembers)
      .values(members.map((m) => ({ workspaceId: workspace.id, userId: m.user.id, role: m.role })));
  }
  const boardIds: string[] = [];
  for (const name of boardNames) {
    const [board] = await db
      .insert(boards)
      .values({ workspaceId: workspace.id, name })
      .returning({ id: boards.id });
    if (board) boardIds.push(board.id);
  }
  return { id: workspace.id, boardIds };
};

/** A board with the given columns, created directly in the database. */
export const makeBoard = async (
  workspaceId: string,
  columnNames: string[] = ['Todo', 'Doing', 'Done'],
) => {
  const { db } = testDb();
  const [board] = await db
    .insert(boards)
    .values({ workspaceId, name: `Board ${randomUUID().slice(0, 6)}` })
    .returning({ id: boards.id });
  if (!board) throw new Error('board insert failed');
  const keys = evenlySpacedKeys(columnNames.length);
  const columns = await db
    .insert(boardColumns)
    .values(columnNames.map((name, i) => ({ boardId: board.id, name, position: keys[i] ?? 'a0' })))
    .returning({ id: boardColumns.id, name: boardColumns.name });
  const columnIds = columnNames.map((name) => columns.find((c) => c.name === name)?.id ?? '');
  return { id: board.id, columnIds };
};
