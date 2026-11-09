import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cards } from '../src/schema';
import { createFixture, readColumn } from './support/fixture';
import { startTestDatabase, type TestDatabase } from './support/postgres';
import { MAX_POSITION_LENGTH } from '../src/positions';
import { moveCardInTx, type MoveCardInput } from '../src/ops/move-card';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
});

afterAll(async () => {
  await database.stop();
});

const move = (input: MoveCardInput) => database.db.transaction((tx) => moveCardInTx(tx, input));

const order = async (columnId: string) =>
  (await readColumn(database.db, columnId)).map((c) => c.id);

const expectValidOrder = async (columnId: string, expectedIds: string[]) => {
  const rows = await readColumn(database.db, columnId);
  expect(rows.map((row) => row.id).sort()).toEqual([...expectedIds].sort());
  expect(new Set(rows.map((row) => row.position)).size).toBe(rows.length); // no ties
  return rows;
};

describe('moveCardInTx: placement', () => {
  it('places a card after / before an anchor and at the end', async () => {
    const f = await createFixture(database.db, 5);
    const [a, b, c, d, e] = f.cardIds as [string, string, string, string, string];
    const [todo, doing] = f.columnIds;

    await move({ cardId: e, columnId: todo, afterId: a });
    expect(await order(todo)).toEqual([a, e, b, c, d]);

    await move({ cardId: a, columnId: todo, beforeId: d });
    expect(await order(todo)).toEqual([e, b, c, a, d]);

    await move({ cardId: e, columnId: todo }); // no anchors: end of column
    expect(await order(todo)).toEqual([b, c, a, d, e]);

    await move({ cardId: c, columnId: doing }); // other, empty column
    expect(await order(doing)).toEqual([c]);
    expect(await order(todo)).toEqual([b, a, d, e]);
  });

  it('reports the source column and rejects unknown cards / foreign columns', async () => {
    const f = await createFixture(database.db, 2);
    const other = await createFixture(database.db, 1);

    const ok = await move({ cardId: f.cardIds[0]!, columnId: f.columnIds[1] });
    expect(ok).toMatchObject({ ok: true, fromColumnId: f.columnIds[0], columnId: f.columnIds[1] });

    expect(await move({ cardId: f.cardIds[0]!, columnId: other.columnIds[0] })).toEqual({
      ok: false,
      reason: 'column_not_found',
    });
    expect(
      await move({ cardId: '00000000-0000-0000-0000-000000000000', columnId: f.columnIds[0] }),
    ).toEqual({ ok: false, reason: 'card_not_found' });
  });

  it('does not change the card version', async () => {
    const f = await createFixture(database.db, 2);
    await move({ cardId: f.cardIds[0]!, columnId: f.columnIds[0], afterId: f.cardIds[1]! });
    const [row] = await database.db.select().from(cards).where(eq(cards.id, f.cardIds[0]!));
    expect(row?.version).toBe(1);
  });
});

describe('moveCardInTx: stale anchors never fail', () => {
  it('falls back when the anchor was moved to another column', async () => {
    const f = await createFixture(database.db, 4);
    const [a, b, c, d] = f.cardIds as [string, string, string, string];
    await move({ cardId: b, columnId: f.columnIds[1] }); // anchor leaves

    // afterId is stale, beforeId still valid -> placed before c
    await move({ cardId: d, columnId: f.columnIds[0], afterId: b, beforeId: c });
    expect(await order(f.columnIds[0])).toEqual([a, d, c]);

    // both anchors stale -> end of column
    await move({ cardId: a, columnId: f.columnIds[0], afterId: b, beforeId: b });
    expect(await order(f.columnIds[0])).toEqual([d, c, a]);
  });

  it('ignores a soft-deleted anchor', async () => {
    const f = await createFixture(database.db, 3);
    const [a, b, c] = f.cardIds as [string, string, string];
    await database.db.update(cards).set({ deletedAt: new Date() }).where(eq(cards.id, b));
    await move({ cardId: c, columnId: f.columnIds[0], afterId: b });
    expect(await order(f.columnIds[0])).toEqual([a, c]);
  });

  it('prefers afterId when both anchors are valid but no longer adjacent', async () => {
    const f = await createFixture(database.db, 4);
    const [a, b, c, d] = f.cardIds as [string, string, string, string];
    await move({ cardId: d, columnId: f.columnIds[0], afterId: a, beforeId: c });
    expect(await order(f.columnIds[0])).toEqual([a, d, b, c]);
  });
});

describe('moveCardInTx: concurrency', () => {
  it('keeps one valid total order under many parallel moves from several pools', async () => {
    const f = await createFixture(database.db, 40);
    const pools = [database.connect(), database.connect(), database.connect()];

    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) => {
        const pool = pools[i % pools.length]!;
        const cardId = f.cardIds[(i * 7) % f.cardIds.length]!;
        const afterId = f.cardIds[(i * 13 + 3) % f.cardIds.length]!;
        const beforeId = f.cardIds[(i * 5 + 1) % f.cardIds.length]!;
        const column = f.columnIds[i % 4 === 0 ? 1 : 0];
        return pool.db.transaction((tx) =>
          moveCardInTx(tx, { cardId, columnId: column, afterId, beforeId }),
        );
      }),
    );

    expect(results.every((result) => result.ok)).toBe(true);

    const todo = await readColumn(database.db, f.columnIds[0]);
    const doing = await readColumn(database.db, f.columnIds[1]);
    expect(todo.length + doing.length).toBe(40);
    for (const column of [todo, doing]) {
      expect(new Set(column.map((row) => row.position)).size).toBe(column.length);
    }
    // Reading again gives the identical order: what every client will converge on.
    expect(await readColumn(database.db, f.columnIds[0])).toEqual(todo);
  });

  it('moves relative to a neighbour that is being moved at the same time', async () => {
    const f = await createFixture(database.db, 6);
    const [a, b, c, d, e, g] = f.cardIds as [string, string, string, string, string, string];
    const pools = [database.connect(), database.connect()];

    const results = await Promise.all([
      pools[0]!.db.transaction((tx) => moveCardInTx(tx, { cardId: a, columnId: f.columnIds[1] })),
      pools[1]!.db.transaction((tx) =>
        moveCardInTx(tx, { cardId: g, columnId: f.columnIds[0], afterId: a, beforeId: b }),
      ),
      pools[0]!.db.transaction((tx) =>
        moveCardInTx(tx, { cardId: e, columnId: f.columnIds[0], afterId: a }),
      ),
      pools[1]!.db.transaction((tx) =>
        moveCardInTx(tx, { cardId: c, columnId: f.columnIds[0], beforeId: a }),
      ),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const todo = await expectValidOrder(f.columnIds[0], [b, c, d, e, g]);
    expect(todo).toHaveLength(5);
  });
});

describe('moveCardInTx: key growth and rebalancing', () => {
  it('10,000 moves of one card between the same two neighbours keep a stable order', async () => {
    const f = await createFixture(database.db, 3);
    const [a, m, b] = f.cardIds as [string, string, string];
    let rebalances = 0;
    let longest = 0;

    for (let i = 0; i < 10_000; i += 1) {
      const result = await move({ cardId: m, columnId: f.columnIds[0], afterId: a, beforeId: b });
      if (!result.ok) throw new Error(`move ${i} failed: ${result.reason}`);
      if (result.rebalanced) rebalances += 1;
      longest = Math.max(longest, result.position.length);
    }

    const rows = await expectValidOrder(f.columnIds[0], [a, m, b]);
    expect(rows.map((row) => row.id)).toEqual([a, m, b]);
    // Re-dropping a card into the slot it already occupies must not make its key creep
    // towards a neighbour: the key stays short and no rebalance is ever needed.
    expect(rebalances).toBe(0);
    expect(longest).toBeLessThanOrEqual(4);
  });

  it('keeps keys bounded by rebalancing when two cards leapfrog each other', async () => {
    const f = await createFixture(database.db, 4);
    const [a, m, n, b] = f.cardIds as [string, string, string, string];
    let rebalances = 0;
    let longest = 0;

    for (let i = 0; i < 3_000; i += 1) {
      // Always insert directly after `a`, alternating cards: the interval keeps halving.
      const result = await move({
        cardId: i % 2 === 0 ? m : n,
        columnId: f.columnIds[0],
        afterId: a,
      });
      if (!result.ok) throw new Error(`move ${i} failed: ${result.reason}`);
      if (result.rebalanced) rebalances += 1;
      longest = Math.max(longest, result.position.length);
    }

    expect(rebalances).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(MAX_POSITION_LENGTH + 1);
    const rows = await expectValidOrder(f.columnIds[0], [a, m, n, b]);
    expect(rows.map((row) => row.id)[0]).toBe(a);
    expect(rows.map((row) => row.id)[3]).toBe(b);
    const maxStored = await database.db.execute<{ max: number }>(
      sql`select max(length(position)) as max from cards where column_id = ${f.columnIds[0]}`,
    );
    expect(Number(maxStored.rows[0]?.max)).toBeLessThanOrEqual(MAX_POSITION_LENGTH);
  });

  it('repairs a column when the neighbours of the move have tied keys', async () => {
    const f = await createFixture(database.db, 3);
    const [first, second, c] = f.cardIds as [string, string, string];
    // Ties are impossible in normal operation (no unique index forbids them, the lock
    // prevents them). Force one anyway: `y` shares the key of `x`, and sorts right after it.
    const [x, y] = [first, second].sort() as [string, string];
    const [rowX] = await database.db.select().from(cards).where(eq(cards.id, x));
    await database.db.update(cards).set({ position: rowX!.position }).where(eq(cards.id, y));

    const result = await move({ cardId: c, columnId: f.columnIds[0], afterId: x });
    expect(result.ok).toBe(true);
    const rows = await expectValidOrder(f.columnIds[0], [x, y, c]);
    expect(rows.map((row) => row.id)).toEqual([x, c, y]);
  });
});
