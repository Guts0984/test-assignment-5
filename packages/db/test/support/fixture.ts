import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database } from '../../src/client';
import { evenlySpacedKeys } from '../../src/positions';
import { boardColumns, boards, cards, users, workspaceMembers, workspaces } from '../../src/schema';

export const only = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
};

export type Fixture = {
  userId: string;
  workspaceId: string;
  boardId: string;
  /** [todo, doing] */
  columnIds: [string, string];
  /** Cards created in `todo`, in board order. */
  cardIds: string[];
};

/** One user, one workspace, one board with two columns and `cardCount` cards in the first. */
export const createFixture = async (db: Database, cardCount: number): Promise<Fixture> => {
  const suffix = randomUUID().slice(0, 8);

  const user = only(
    await db
      .insert(users)
      .values({
        email: `u${suffix}@test.io`,
        handle: `u${suffix}`,
        name: 'Test',
        passwordHash: 'x',
      })
      .returning({ id: users.id }),
  );
  const workspace = only(
    await db.insert(workspaces).values({ name: 'Workspace' }).returning({ id: workspaces.id }),
  );
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
  const board = only(
    await db
      .insert(boards)
      .values({ workspaceId: workspace.id, name: 'Board' })
      .returning({ id: boards.id }),
  );
  const columns = await db
    .insert(boardColumns)
    .values([
      { boardId: board.id, name: 'todo', position: 'a0' },
      { boardId: board.id, name: 'doing', position: 'a1' },
    ])
    .returning({ id: boardColumns.id, name: boardColumns.name });
  const todo = only(columns.filter((column) => column.name === 'todo'));
  const doing = only(columns.filter((column) => column.name === 'doing'));

  const keys = evenlySpacedKeys(cardCount);
  const inserted =
    cardCount === 0
      ? []
      : await db
          .insert(cards)
          .values(
            keys.map((position, index) => ({
              workspaceId: workspace.id,
              boardId: board.id,
              columnId: todo.id,
              title: `card ${String(index).padStart(5, '0')}`,
              position,
              createdBy: user.id,
            })),
          )
          .returning({ id: cards.id, title: cards.title });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    boardId: board.id,
    columnIds: [todo.id, doing.id],
    cardIds: inserted.sort((a, b) => a.title.localeCompare(b.title)).map((card) => card.id),
  };
};

/** Live cards of a column exactly as the board shows them: ordered by (position, id). */
export const readColumn = async (
  db: Database,
  columnId: string,
): Promise<{ id: string; position: string }[]> => {
  const result = await db.execute<{ id: string; position: string }>(
    sql`select id, position from cards
        where column_id = ${columnId} and deleted_at is null
        order by position asc, id asc`,
  );
  return result.rows;
};
