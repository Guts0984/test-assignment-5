import { sql, type SQL } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';

import type { Transaction } from '../client';
import { evenlySpacedKeys, isPositionTooLong, keyBetween } from '../positions';

/** A card id that cannot exist, used when nothing has to be excluded from the neighbours. */
const NO_CARD = '00000000-0000-0000-0000-000000000000';

// Drizzle types `rows` as a conditional type over T that TypeScript cannot resolve for a
// generic T, so the cast below only restates what the constraint already guarantees.
export const rowsOf = async <T extends QueryResultRow>(tx: Transaction, query: SQL): Promise<T[]> =>
  (await tx.execute<T>(query)).rows as unknown as T[];

export const firstRow = async <T extends QueryResultRow>(
  tx: Transaction,
  query: SQL,
): Promise<T | undefined> => (await rowsOf<T>(tx, query))[0];

/**
 * All moves and inserts into one column take this lock, so they run one at a time and each
 * sees the order produced by the previous one. Transaction-scoped: released on commit.
 */
export const lockColumn = async (tx: Transaction, columnId: string): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${columnId}::text, 0))`);
};

export type Placement = {
  columnId: string;
  /** The card being moved (it is never its own neighbour); null when inserting a new card. */
  excludeId: string | null;
  /** Card that should end up directly above. */
  afterId?: string | null;
  /** Card that should end up directly below. */
  beforeId?: string | null;
};

type PositionRow = { id: string; position: string };
type Neighbours = { prev: string | null; next: string | null };

const findAnchor = (tx: Transaction, placement: Placement, anchorId: string) =>
  firstRow<PositionRow>(
    tx,
    sql`select id, position from cards
        where id = ${anchorId} and column_id = ${placement.columnId}
          and id <> ${placement.excludeId ?? NO_CARD} and deleted_at is null`,
  );

/**
 * Resolves the keys the card must go between. Anchors are looked up by id at the moment of the
 * operation, so an anchor that was moved, deleted or never existed is ignored instead of
 * producing an error:
 *   1. `afterId` valid  -> directly after it (before whatever currently follows it)
 *   2. else `beforeId` valid -> directly before it
 *   3. else -> end of the column
 */
export const findNeighbours = async (
  tx: Transaction,
  placement: Placement,
): Promise<Neighbours> => {
  const { columnId, afterId, beforeId } = placement;
  const exclude = placement.excludeId ?? NO_CARD;

  if (afterId) {
    const anchor = await findAnchor(tx, placement, afterId);
    if (anchor) {
      const following = await firstRow<{ position: string }>(
        tx,
        sql`select position from cards
            where column_id = ${columnId} and deleted_at is null and id <> ${exclude}
              and (position, id) > (${anchor.position}, ${anchor.id})
            order by position asc, id asc limit 1`,
      );
      return { prev: anchor.position, next: following?.position ?? null };
    }
  }

  if (beforeId) {
    const anchor = await findAnchor(tx, placement, beforeId);
    if (anchor) {
      const preceding = await firstRow<{ position: string }>(
        tx,
        sql`select position from cards
            where column_id = ${columnId} and deleted_at is null and id <> ${exclude}
              and (position, id) < (${anchor.position}, ${anchor.id})
            order by position desc, id desc limit 1`,
      );
      return { prev: preceding?.position ?? null, next: anchor.position };
    }
  }

  const last = await firstRow<{ position: string }>(
    tx,
    sql`select position from cards
        where column_id = ${columnId} and deleted_at is null and id <> ${exclude}
        order by position desc, id desc limit 1`,
  );
  return { prev: last?.position ?? null, next: null };
};

/**
 * Gives every live card of the column a fresh, short, evenly spaced key, preserving the current
 * order. The `column_id` guard in the UPDATE makes this safe against a card that leaves the
 * column concurrently: its row is skipped and keeps the key its mover chose.
 * Must run while holding the column's lock.
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

/** Every live card of a column with its key, in board order. */
export const columnPositions = (tx: Transaction, columnId: string): Promise<PositionRow[]> =>
  rowsOf<PositionRow>(
    tx,
    sql`select id, position from cards
        where column_id = ${columnId} and deleted_at is null
        order by position asc, id asc`,
  );

/**
 * The key for a card going into `placement`. If the neighbours' keys are equal or inverted
 * (impossible in normal operation) the column is repaired first instead of failing.
 * Call while holding the column's lock.
 */
export const keyFor = async (tx: Transaction, placement: Placement): Promise<string> => {
  let { prev, next } = await findNeighbours(tx, placement);
  if (prev !== null && next !== null && prev >= next) {
    await rebalanceColumn(tx, placement.columnId);
    ({ prev, next } = await findNeighbours(tx, placement));
  }
  return keyBetween(prev, next);
};

export { isPositionTooLong };
