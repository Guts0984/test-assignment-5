import { sql } from 'drizzle-orm';

import type { Transaction } from '../client';
import { cards } from '../schema';
import { firstRow, isPositionTooLong, keyFor, lockColumn, rebalanceColumn } from './placement';

export type CreateCardInput = {
  workspaceId: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  createdBy: string;
  /** Insert directly after / before this card; both absent (or stale) means the end of the column. */
  afterId?: string | null;
  beforeId?: string | null;
};

export type CreateCardResult =
  | { ok: true; card: typeof cards.$inferSelect; rebalanced: boolean }
  | { ok: false; reason: 'column_not_found' };

/**
 * Inserts a card into a column at the requested place, under the same per-column lock and with
 * the same ordering rules as moves. MUST be called inside a transaction.
 */
export const createCardInTx = async (
  tx: Transaction,
  input: CreateCardInput,
): Promise<CreateCardResult> => {
  const column = await firstRow<{ id: string }>(
    tx,
    sql`select id from board_columns where id = ${input.columnId} and board_id = ${input.boardId}`,
  );
  if (!column) return { ok: false, reason: 'column_not_found' };

  await lockColumn(tx, input.columnId);
  const position = await keyFor(tx, {
    columnId: input.columnId,
    excludeId: null,
    afterId: input.afterId,
    beforeId: input.beforeId,
  });

  const [inserted] = await tx
    .insert(cards)
    .values({
      workspaceId: input.workspaceId,
      boardId: input.boardId,
      columnId: input.columnId,
      title: input.title,
      description: input.description,
      position,
      createdBy: input.createdBy,
    })
    .returning();
  if (!inserted) throw new Error('card insert returned nothing');

  let card = inserted;
  let rebalanced = false;
  if (isPositionTooLong(position)) {
    await rebalanceColumn(tx, input.columnId);
    rebalanced = true;
    const [fresh] = await tx
      .select()
      .from(cards)
      .where(sql`${cards.id} = ${inserted.id}`);
    card = fresh ?? inserted;
  }
  return { ok: true, card, rebalanced };
};
