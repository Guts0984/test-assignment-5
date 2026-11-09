import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, positionKey, primaryId } from './columns';
import { workspaces } from './workspaces';

export const boards = pgTable(
  'boards',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('boards_name_length', sql`char_length(${t.name}) between 1 and 100`),
    index('boards_workspace_idx').on(t.workspaceId),
    // Target of composite foreign keys that keep child rows in the same workspace.
    unique('boards_id_workspace_unique').on(t.id, t.workspaceId),
  ],
);

export const boardColumns = pgTable(
  'board_columns',
  {
    id: primaryId(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: positionKey('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('board_columns_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('board_columns_position_format', sql`${t.position} ~ '^[0-9A-Za-z]+$'`),
    // Columns are never reordered by the API, so strict uniqueness is safe here.
    unique('board_columns_position_unique').on(t.boardId, t.position),
    // Target of the composite foreign key from cards.
    unique('board_columns_id_board_unique').on(t.id, t.boardId),
  ],
);
