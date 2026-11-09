import { sql } from 'drizzle-orm';

import type { Transaction } from '../client';
import { firstRow, isPositionTooLong, keyFor, lockColumn, rebalanceColumn } from './placement';

export type MoveCardInput = {
  cardId: string;
  /** Destination column (may equal the current one). */
  columnId: string;
  /** Card that should end up directly above the moved card. */
  afterId?: string | null;
  /** Card that should end up directly below the moved card. */
  beforeId?: string | null;
};

export type MoveCardResult =
  | {
      ok: true;
      fromColumnId: string;
      columnId: string;
      /** Final key of the moved card (after any rebalance). */
      position: string;
      /** True if every card of the destination column received a new key. */
      rebalanced: boolean;
    }
  | { ok: false; reason: 'card_not_found' | 'column_not_found' };

export { rebalanceColumn } from './placement';

/**
 * Moves a card to a column, between two neighbours given as card ids.
 *
 * MUST be called inside a transaction (the lock below is transaction-scoped). The caller
 * adds its own work (activity log, outbox rows) to the same transaction. Ids must be valid
 * UUIDs; validate them with Zod before calling.
 *
 * Concurrency: all moves into one column take the same advisory lock, so they run one at a
 * time and every move sees the order produced by the previous one. The database is the
 * single source of truth for order; clients converge on whatever it holds.
 * Only the destination column is locked: removing a card from the source column cannot
 * invalidate that column's order.
 *
 * Does not change `version`: version guards edits of card content, and a drag must not
 * make a concurrent edit of the same card fail with 409.
 */
export const moveCardInTx = async (
  tx: Transaction,
  input: MoveCardInput,
): Promise<MoveCardResult> => {
  const { cardId, columnId } = input;

  const card = await firstRow<{ board_id: string }>(
    tx,
    sql`select board_id from cards where id = ${cardId} and deleted_at is null`,
  );
  if (!card) return { ok: false, reason: 'card_not_found' };

  const column = await firstRow<{ id: string }>(
    tx,
    sql`select id from board_columns where id = ${columnId} and board_id = ${card.board_id}`,
  );
  if (!column) return { ok: false, reason: 'column_not_found' };

  await lockColumn(tx, columnId);

  // Re-read under lock: the card may have been moved or deleted while we waited.
  const current = await firstRow<{ column_id: string }>(
    tx,
    sql`select column_id from cards where id = ${cardId} and deleted_at is null for update`,
  );
  if (!current) return { ok: false, reason: 'card_not_found' };

  const position = await keyFor(tx, {
    columnId,
    excludeId: cardId,
    afterId: input.afterId,
    beforeId: input.beforeId,
  });
  await tx.execute(
    sql`update cards set column_id = ${columnId}, position = ${position}, updated_at = now()
        where id = ${cardId}`,
  );

  let rebalanced = false;
  let finalPosition = position;
  if (isPositionTooLong(position)) {
    await rebalanceColumn(tx, columnId);
    rebalanced = true;
    const updated = await firstRow<{ position: string }>(
      tx,
      sql`select position from cards where id = ${cardId}`,
    );
    finalPosition = updated?.position ?? position;
  }

  return {
    ok: true,
    fromColumnId: current.column_id,
    columnId,
    position: finalPosition,
    rebalanced,
  };
};
