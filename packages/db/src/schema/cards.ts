import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { boardColumns, boards } from './boards';
import { createdAt, positionKey, primaryId, tsvector } from './columns';
import { users } from './users';
import { workspaces } from './workspaces';

export const cards = pgTable(
  'cards',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id').notNull(),
    columnId: uuid('column_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    position: positionKey('position').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
  },
  (t) => [
    foreignKey({
      name: 'cards_board_workspace_fk',
      columns: [t.boardId, t.workspaceId],
      foreignColumns: [boards.id, boards.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'cards_column_board_fk',
      columns: [t.columnId, t.boardId],
      foreignColumns: [boardColumns.id, boardColumns.boardId],
    }).onDelete('cascade'),
    check('cards_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('cards_description_length', sql`char_length(${t.description}) <= 20000`),
    check('cards_position_format', sql`${t.position} ~ '^[0-9A-Za-z]+$'`),
    check('cards_version_positive', sql`${t.version} >= 1`),
    // Board load and move: live cards of a column in order.
    index('cards_column_order_idx')
      .on(t.columnId, t.position, t.id)
      .where(sql`${t.deletedAt} is null`),
    index('cards_board_idx').on(t.boardId),
    // Worker cleanup of soft-deleted cards.
    index('cards_deleted_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index('cards_search_idx').using('gin', t.searchVector),
    // Target of composite foreign keys from comments and attachments.
    unique('cards_id_workspace_unique').on(t.id, t.workspaceId),
  ],
);
