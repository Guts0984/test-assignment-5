import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { moveCardInTx } from '../src/ops/move-card';
import { verifyPassword } from '../src/password';
import { seedDatabase } from '../src/seed';
import { users } from '../src/schema';
import { readColumn } from './support/fixture';
import { startTestDatabase, type TestDatabase } from './support/postgres';

const PASSWORD = 'demo-password-1';
let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate table users, workspaces restart identity cascade`);
});

const rows = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  (await database.db.execute(query)).rows as unknown as T[];

const count = async (table: string): Promise<number> =>
  Number(
    (await rows<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)}`))[0]?.n,
  );

describe('seedDatabase', () => {
  it('creates exactly the demo data the assignment asks for', async () => {
    const result = await seedDatabase(database.db, PASSWORD);

    expect(result).toMatchObject({ seeded: true, workspaces: 2, users: 4, boards: 3, columns: 15 });
    // The reported summary matches what is really in the database.
    expect(result.seeded && result.cards).toBe(await count('cards'));
    expect([await count('workspaces'), await count('users'), await count('boards')]).toEqual([
      2, 4, 3,
    ]);

    const perBoard = await rows<{ name: string; columns: string; cards: string }>(sql`
      select b.name,
             (select count(*) from board_columns c where c.board_id = b.id) as columns,
             (select count(*) from cards k where k.board_id = b.id) as cards
      from boards b order by b.name`);
    expect(perBoard.every((board) => Number(board.columns) === 5)).toBe(true);
    const big = perBoard.filter((board) => Number(board.cards) >= 1000);
    expect(big).toHaveLength(1);
    expect(Number(big[0]?.cards)).toBe(1000);
  });

  it('gives the four users different roles and keeps the workspaces isolated', async () => {
    await seedDatabase(database.db, PASSWORD);
    const memberships = await rows<{ handle: string; workspace: string; role: string }>(sql`
      select u.handle, w.name as workspace, m.role
      from workspace_members m
      join users u on u.id = m.user_id
      join workspaces w on w.id = m.workspace_id
      order by u.handle, w.name`);

    const roles = new Set(memberships.map((m) => m.role));
    expect(roles).toEqual(new Set(['owner', 'editor', 'viewer']));

    const workspacesOf = (handle: string) =>
      memberships.filter((m) => m.handle === handle).map((m) => m.workspace);
    // Users that must NOT see the other workspace: the basis of the "foreign id" checks.
    expect(workspacesOf('alice')).toEqual(['Acme Product']);
    expect(workspacesOf('carol')).toEqual(['Acme Product']);
    expect(workspacesOf('dave')).toEqual(['Beta Studio']);
    expect(workspacesOf('bob')).toEqual(['Acme Product', 'Beta Studio']);
    // Every workspace has an owner.
    for (const workspace of ['Acme Product', 'Beta Studio']) {
      expect(memberships.some((m) => m.workspace === workspace && m.role === 'owner')).toBe(true);
    }
  });

  it('stores working password hashes, never the password itself', async () => {
    await seedDatabase(database.db, PASSWORD);
    const stored = await database.db.select({ hash: users.passwordHash }).from(users);
    expect(stored).toHaveLength(4);
    for (const { hash } of stored) {
      expect(hash).not.toContain(PASSWORD);
      expect(await verifyPassword(PASSWORD, hash)).toBe(true);
      expect(await verifyPassword('wrong-password', hash)).toBe(false);
    }
  });

  it('is idempotent, including when several runners start at once', async () => {
    const pools = [database.connect(), database.connect(), database.connect(), database.connect()];
    const results = await Promise.all(pools.map(({ db }) => seedDatabase(db, PASSWORD)));
    expect(results.filter((r) => r.seeded)).toHaveLength(1);

    const snapshot = async () => [
      await count('users'),
      await count('workspaces'),
      await count('boards'),
      await count('board_columns'),
      await count('cards'),
    ];
    const before = await snapshot();
    expect(before.slice(0, 4)).toEqual([4, 2, 3, 15]);

    expect(await seedDatabase(database.db, PASSWORD)).toEqual({ seeded: false });
    expect(await snapshot()).toEqual(before);
  });

  it('never touches a database that already holds real data', async () => {
    await database.db.insert(users).values({
      email: 'real@company.io',
      handle: 'realuser',
      name: 'Real User',
      passwordHash: 'x',
    });
    expect(await seedDatabase(database.db, PASSWORD)).toEqual({ seeded: false });
    expect(await count('users')).toBe(1);
    expect(await count('workspaces')).toBe(0);
  });

  it('produces valid fractional order keys in every column', async () => {
    await seedDatabase(database.db, PASSWORD);
    const columns = await rows<{ id: string }>(sql`select id from board_columns`);
    for (const { id } of columns) {
      const cards = await readColumn(database.db, id);
      expect(new Set(cards.map((card) => card.position)).size).toBe(cards.length);
      for (const card of cards) expect(card.position.length).toBeLessThanOrEqual(4);
    }
  });

  it('produces cards that full-text search can find, with ranking', async () => {
    await seedDatabase(database.db, PASSWORD);
    const hits = await rows<{ title: string; rank: number }>(sql`
      select title, ts_rank(search_vector, websearch_to_tsquery('english', 'login flow')) as rank
      from cards
      where search_vector @@ websearch_to_tsquery('english', 'login flow')
      order by rank desc limit 5`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title.toLowerCase()).toContain('login');
  });

  it('is compatible with moving cards on the 1,000-card board', async () => {
    await seedDatabase(database.db, PASSWORD);
    const [column] = await rows<{ id: string; n: string }>(sql`
      select column_id as id, count(*) as n from cards group by column_id order by count(*) desc limit 1`);
    const before = await readColumn(database.db, column!.id);
    expect(before).toHaveLength(400);

    const moving = before[10]!;
    const anchor = before[300]!;
    const result = await database.db.transaction((tx) =>
      moveCardInTx(tx, { cardId: moving.id, columnId: column!.id, afterId: anchor.id }),
    );
    expect(result.ok).toBe(true);

    const after = await readColumn(database.db, column!.id);
    expect(after).toHaveLength(400);
    expect(new Set(after.map((card) => card.position)).size).toBe(400);
    const ids = after.map((card) => card.id);
    expect(ids.indexOf(moving.id)).toBe(ids.indexOf(anchor.id) + 1);
  });
});
