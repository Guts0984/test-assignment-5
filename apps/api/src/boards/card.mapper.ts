import type { cards } from '@kanban/db';
import type { Card } from '@kanban/shared';

export const toCard = (row: typeof cards.$inferSelect): Card => ({
  id: row.id,
  boardId: row.boardId,
  columnId: row.columnId,
  title: row.title,
  description: row.description,
  position: row.position,
  version: row.version,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
