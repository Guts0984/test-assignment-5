import { sql, type SQL } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';

import type { Transaction } from '../client';
import { evenlySpacedKeys, isPositionTooLong, keyBetween } from '../positions';

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

type Neighbours = { prev: string | null; next: string | null };
type PositionRow = { id: string; position: string };

// Drizzle types `rows` as a conditional type over T that TypeScript cannot resolve for a
// generic T, so the cast below only restates what the constraint already guarantees.
const rowsOf = async <T extends QueryResultRow>(tx: Transaction, query: SQL): Promise<T[]> =>
  (await tx.execute<T>(query)).rows as unknown as T[];

const firstRow = async <T extends QueryResultRow>(
  tx: Transaction,
  query: SQL,
): Promise<T | undefined> => (await rowsOf<T>(tx, query))[0];

const findAnchor = (tx: Transaction, columnId: string, movingId: string, anchorId: string) =>
  firstRow<PositionRow>(
    tx,
    sql`select id, position from cards
        where id = ${anchorId} and column_id = ${columnId}
          and id <> ${movingId} and deleted_at is null`,
  );

/**
 * Resolves the keys the moved card must go between. Anchors are looked up by id at the
 * moment of the move, so an anchor that was moved, deleted or never existed is simply
 * ignored instead of producing an error:
 *   1. `afterId` valid  -> directly after it (before whatever currently follows it)
 *   2. else `beforeId` valid -> directly before it
 *   3. else -> end of the column
 * The moving card itself is always excluded from the neighbours.
 */
const findNeighbours = async (tx: Transaction, input: MoveCardInput): Promise<Neighbours> => {
  const { cardId, columnId, afterId, beforeId } = input;

  if (afterId) {
    const anchor = await findAnchor(tx, columnId, cardId, afterId);
    if (anchor) {
      const following = await firstRow<{ position: string }>(
        tx,
        sql`select position from cards
            where column_id = ${columnId} and deleted_at is null and id <> ${cardId}
              and (position, id) > (${anchor.position}, ${anchor.id})
            order by position asc, id asc limit 1`,
      );
      return { prev: anchor.position, next: following?.position ?? null };
    }
  }

  if (beforeId) {
    const anchor = await findAnchor(tx, columnId, cardId, beforeId);
    if (anchor) {
      const preceding = await firstRow<{ position: string }>(
        tx,
        sql`select position from cards
            where column_id = ${columnId} and deleted_at is null and id <> ${cardId}
              and (position, id) < (${anchor.position}, ${anchor.id})
            order by position desc, id desc limit 1`,
      );
      return { prev: preceding?.position ?? null, next: anchor.position };
    }
  }

  const last = await firstRow<{ position: string }>(
    tx,
    sql`select position from cards
        where column_id = ${columnId} and deleted_at is null and id <> ${cardId}
        order by position desc, id desc limit 1`,
  );
  return { prev: last?.position ?? null, next: null };
};

/**
 * Gives every live card of the column a fresh, short, evenly spaced key, preserving the
 * current order. The `column_id` guard in the UPDATE makes this safe against a card that
 * leaves the column concurrently: its row is skipped and keeps the key its mover chose.
 * Must run while holding the column's advisory lock.
 */
export const rebalanceColumn = async (tx: Transaction, columnId: string): Promise<void> => {
  const cards = await rowsOf<{ id: string }>(
    tx,
    sql`select id from cards
        where column_id = ${columnId} and deleted_at is null
        order by position asc, id asc`,
  );
  if (cards.length === 0) return;

  const keys = evenlySpacedKeys(cards.length);
  const values = sql.join(
    cards.map((card, index) => sql`(${card.id}::uuid, ${keys[index] ?? ''}::text)`),
    sql`, `,
  );
  await tx.execute(
    sql`update cards set position = v.position
        from (values ${values}) as v(id, position)
        where cards.id = v.id and cards.column_id = ${columnId}`,
  );
};

/**
 * Moves a card to a column, between two neighbours given as card ids.
 *
 * MUST be called inside a transaction (the lock below is transaction-scoped). The caller
 * adds its own work (activity log, outbox rows) to the same transaction. Ids must be valid
 * UUIDs; validate them with Zod before calling.
 *
 * Concurrency: all moves into one column take the same advisory lock, so they run one at
 * a time and every move sees the order produced by the previous one. The database is the
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

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${columnId}::text, 0))`);

  // Re-read under lock: the card may have been moved or deleted while we waited.
  const current = await firstRow<{ column_id: string }>(
    tx,
    sql`select column_id from cards where id = ${cardId} and deleted_at is null for update`,
  );
  if (!current) return { ok: false, reason: 'card_not_found' };

  let { prev, next } = await findNeighbours(tx, input);
  if (prev !== null && next !== null && prev >= next) {
    // Equal or inverted neighbour keys should be impossible; if they ever appear, repair
    // the column instead of failing.
    await rebalanceColumn(tx, columnId);
    ({ prev, next } = await findNeighbours(tx, input));
  }

  const position = keyBetween(prev, next);
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
