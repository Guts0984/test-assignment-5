import { sql } from 'drizzle-orm';

import type { Database } from './client';
import { hashPassword } from './password';
import { evenlySpacedKeys } from './positions';
import { boardColumns, boards, cards, users, workspaceMembers, workspaces } from './schema';
import type { WorkspaceRole } from './schema';

/** Arbitrary constant: only one process at a time may seed. */
const SEED_LOCK_KEY = 727_002;

const COLUMN_NAMES = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'] as const;
const CHUNK_SIZE = 500;

const VERBS = [
  'Fix',
  'Implement',
  'Refactor',
  'Design',
  'Review',
  'Document',
  'Optimize',
  'Investigate',
  'Migrate',
  'Test',
  'Polish',
  'Prototype',
];
const SUBJECTS = [
  'login flow',
  'search index',
  'billing page',
  'email digest',
  'drag and drop',
  'board header',
  'notification settings',
  'file upload',
  'comment thread',
  'workspace invite',
  'activity feed',
  'session handling',
  'rate limiter',
  'dashboard widget',
  'keyboard shortcuts',
  'export to CSV',
];
const DETAILS = [
  'Users reported this is slow on large boards.',
  'Needs a decision from the product owner before work starts.',
  'Blocked by the infrastructure migration.',
  'Customers keep asking about this in support tickets.',
  'Follow-up from the last retrospective.',
  'Small change, but touches several modules.',
  'Should be covered by an end to end test.',
  'Check behaviour with an unreliable network connection.',
];

/** Small deterministic PRNG so the demo data is identical on every run. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const DEMO_USERS = [
  { handle: 'alice', name: 'Alice Owner' },
  { handle: 'bob', name: 'Bob Editor' },
  { handle: 'carol', name: 'Carol Viewer' },
  { handle: 'dave', name: 'Dave Owner' },
] as const;

type Handle = (typeof DEMO_USERS)[number]['handle'];

/**
 * Two workspaces so that cross-workspace isolation can be demonstrated:
 *  - Acme Product: alice (owner), bob (editor), carol (viewer)
 *  - Beta Studio:  dave (owner), bob (viewer)
 * alice and carol cannot see Beta Studio, dave cannot see Acme Product.
 */
const DEMO_WORKSPACES: {
  name: string;
  members: [Handle, WorkspaceRole][];
  boards: { name: string; cardsPerColumn: number[] }[];
}[] = [
  {
    name: 'Acme Product',
    members: [
      ['alice', 'owner'],
      ['bob', 'editor'],
      ['carol', 'viewer'],
    ],
    boards: [
      // 1,000 cards on one board, unevenly spread so one column is very long.
      { name: 'Roadmap', cardsPerColumn: [400, 250, 150, 100, 100] },
      { name: 'Sprint Board', cardsPerColumn: [3, 3, 2, 2, 2] },
    ],
  },
  {
    name: 'Beta Studio',
    members: [
      ['dave', 'owner'],
      ['bob', 'viewer'],
    ],
    boards: [{ name: 'Marketing', cardsPerColumn: [3, 2, 2, 2, 1] }],
  },
];

export type SeedResult =
  | { seeded: false }
  | {
      seeded: true;
      workspaces: number;
      users: number;
      boards: number;
      columns: number;
      cards: number;
    };

/**
 * Creates the demo data. Safe to run any number of times, also concurrently: it takes a lock
 * and does nothing at all if the database already contains users (it never touches real data).
 * `password` is the shared password of the demo users; it comes from the environment.
 */
export const seedDatabase = async (db: Database, password: string): Promise<SeedResult> => {
  const passwordHash = await hashPassword(password);
  const random = mulberry32(20_260_101);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
    const existing = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) return { seeded: false } as const;

    const insertedUsers = await tx
      .insert(users)
      .values(
        DEMO_USERS.map(({ handle, name }) => ({
          email: `${handle}@example.com`,
          handle,
          name,
          passwordHash,
        })),
      )
      .returning({ id: users.id, handle: users.handle });
    const userId = (handle: Handle): string => {
      const user = insertedUsers.find((candidate) => candidate.handle === handle);
      if (!user) throw new Error(`seed user missing: ${handle}`);
      return user.id;
    };

    let boardCount = 0;
    let columnCount = 0;
    let cardCount = 0;

    for (const demo of DEMO_WORKSPACES) {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: demo.name })
        .returning({ id: workspaces.id });
      if (!workspace) throw new Error('workspace insert returned nothing');
      await tx.insert(workspaceMembers).values(
        demo.members.map(([handle, role]) => ({
          workspaceId: workspace.id,
          userId: userId(handle),
          role,
        })),
      );
      const writers = demo.members
        .filter(([, role]) => role !== 'viewer')
        .map(([handle]) => handle);

      for (const demoBoard of demo.boards) {
        const [board] = await tx
          .insert(boards)
          .values({ workspaceId: workspace.id, name: demoBoard.name })
          .returning({ id: boards.id });
        if (!board) throw new Error('board insert returned nothing');
        boardCount += 1;

        const columnKeys = evenlySpacedKeys(COLUMN_NAMES.length);
        const insertedColumns = await tx
          .insert(boardColumns)
          .values(
            COLUMN_NAMES.map((name, i) => ({
              boardId: board.id,
              name,
              position: columnKeys[i] ?? '',
            })),
          )
          .returning({ id: boardColumns.id, name: boardColumns.name });
        columnCount += insertedColumns.length;

        for (const [index, name] of COLUMN_NAMES.entries()) {
          const column = insertedColumns.find((candidate) => candidate.name === name);
          const count = demoBoard.cardsPerColumn[index] ?? 0;
          if (!column || count === 0) continue;
          const keys = evenlySpacedKeys(count);
          const rows = keys.map((position, i) => ({
            workspaceId: workspace.id,
            boardId: board.id,
            columnId: column.id,
            title: `${pick(random, VERBS)} ${pick(random, SUBJECTS)} #${String(i + 1).padStart(3, '0')}`,
            description: `${pick(random, DETAILS)} ${pick(random, DETAILS)}`,
            position,
            createdBy: userId(pick(random, writers)),
          }));
          for (const part of chunks(rows, CHUNK_SIZE)) await tx.insert(cards).values(part);
          cardCount += rows.length;
        }
      }
    }

    return {
      seeded: true,
      workspaces: DEMO_WORKSPACES.length,
      users: insertedUsers.length,
      boards: boardCount,
      columns: columnCount,
      cards: cardCount,
    } as const;
  });
};
