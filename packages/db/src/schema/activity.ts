import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { boards } from './boards';
import { createdAt } from './columns';
import { users } from './users';
import { workspaces } from './workspaces';

export const activityLog = pgTable(
  'activity_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('activity_log_board_idx').on(t.boardId, t.id)],
);
