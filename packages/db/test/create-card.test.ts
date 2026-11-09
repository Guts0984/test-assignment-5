import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCardInTx, type CreateCardInput } from '../src/ops/create-card';
import { moveCardInTx } from '../src/ops/move-card';
import { MAX_POSITION_LENGTH } from '../src/positions';
import { createFixture, readColumn, type Fixture } from './support/fixture';
import { startTestDatabase, type TestDatabase } from './support/postgres';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
});

afterAll(async () => {
  await database.stop();
});

const input = (f: Fixture, overrides: Partial<CreateCardInput> = {}): CreateCardInput => ({
  workspaceId: f.workspaceId,
  boardId: f.boardId,
  columnId: f.columnIds[0],
  title: 'new card',
  description: '',
  createdBy: f.userId,
  ...overrides,
});

const create = async (f: Fixture, overrides: Partial<CreateCardInput> = {}, db = database.db) => {
  const result = await db.transaction((tx) => createCardInTx(tx, input(f, overrides)));
  if (!result.ok) throw new Error(result.reason);
  return result;
};

const order = async (columnId: string) =>
  (await readColumn(database.db, columnId)).map((c) => c.id);

describe('createCardInTx: placement', () => {
  it('puts the card after, before, or at the end of a column, and in an empty one', async () => {
    const f = await createFixture(database.db, 3);
    const [a, b, c] = f.cardIds as [string, string, string];
    const todo = f.columnIds[0];

    const afterA = (await create(f, { afterId: a })).card.id;
    expect(await order(todo)).toEqual([a, afterA, b, c]);

    const beforeC = (await create(f, { beforeId: c })).card.id;
    expect(await order(todo)).toEqual([a, afterA, b, beforeC, c]);

    const last = (await create(f)).card.id;
    expect((await order(todo)).at(-1)).toBe(last);

    const first = (await create(f, { columnId: f.columnIds[1] })).card.id;
    expect(await order(f.columnIds[1])).toEqual([first]);
  });

  it('falls back to the end when the anchors are gone, instead of failing', async () => {
    const f = await createFixture(database.db, 2);
    const gone = '123e4567-e89b-42d3-a456-426614174000';
    const created = (await create(f, { afterId: gone, beforeId: gone })).card.id;
    expect((await order(f.columnIds[0])).at(-1)).toBe(created);
  });

  it('refuses a column of another board', async () => {
    const f = await createFixture(database.db, 1);
    const other = await createFixture(database.db, 1);
    const result = await database.db.transaction((tx) =>
      createCardInTx(tx, input(f, { columnId: other.columnIds[0] })),
    );
    expect(result).toEqual({ ok: false, reason: 'column_not_found' });
  });
});

describe('createCardInTx: concurrency', () => {
  it('many parallel creates and moves from several pools keep one valid order and lose nothing', async () => {
    const f = await createFixture(database.db, 20);
    const pools = [database.connect(), database.connect(), database.connect()];

    const results = await Promise.all(
      Array.from({ length: 150 }, (_, i) => {
        const { db } = pools[i % pools.length]!;
        const anchor = f.cardIds[(i * 7) % f.cardIds.length]!;
        if (i % 3 === 0) {
          return db.transaction((tx) =>
            moveCardInTx(tx, {
              cardId: anchor,
              columnId: f.columnIds[0],
              afterId: f.cardIds[(i * 5 + 1) % f.cardIds.length]!,
            }),
          );
        }
        return db.transaction((tx) =>
          createCardInTx(tx, input(f, { title: `c${i}`, afterId: anchor })),
        );
      }),
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await readColumn(database.db, f.columnIds[0]);
    const created = results.filter((r) => 'card' in r).length;
    expect(rows).toHaveLength(20 + created);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
  });

  it('keeps keys bounded when cards are inserted again and again at the same spot', async () => {
    const f = await createFixture(database.db, 2);
    const [a] = f.cardIds as [string, string];
    let rebalances = 0;
    let longest = 0;
    for (let i = 0; i < 500; i += 1) {
      const { card, rebalanced } = await create(f, { afterId: a });
      if (rebalanced) rebalances += 1;
      longest = Math.max(longest, card.position.length);
    }
    expect(rebalances).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(MAX_POSITION_LENGTH + 1);
    const rows = await readColumn(database.db, f.columnIds[0]);
    expect(rows).toHaveLength(502);
    expect(new Set(rows.map((r) => r.position)).size).toBe(502);
    expect(rows[0]?.id).toBe(a);
  });
});
