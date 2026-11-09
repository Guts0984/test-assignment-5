import { randomUUID } from 'node:crypto';

import { HANDLE_PATTERN, LIMITS } from '@kanban/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attachments,
  boardColumns,
  boards,
  cards,
  comments,
  users,
  workspaces,
} from '../src/schema';
import { createFixture, type Fixture } from './support/fixture';
import { startTestDatabase, type TestDatabase } from './support/postgres';

/**
 * The API validates with the Zod schemas in @kanban/shared; the database repeats the limits as
 * CHECK constraints. If they ever disagree, input that passes validation reaches the database
 * and comes back as a 500. These tests pin the two together.
 */
let database: TestDatabase;
let fixture: Fixture;

beforeAll(async () => {
  database = await startTestDatabase();
  fixture = await createFixture(database.db, 1);
});

afterAll(async () => {
  await database.stop();
});

const CHECK_VIOLATION = '23514';

const errorCode = (error: unknown): string | undefined => {
  const withCode = error as { code?: string; cause?: { code?: string } };
  return withCode.cause?.code ?? withCode.code;
};

/** The value at the limit is stored, one more is refused by the database. */
const atLimit = async (insert: (length: number) => Promise<unknown>, limit: number) => {
  await expect(insert(limit)).resolves.toBeDefined();
  const refused = await insert(limit + 1).then(
    () => undefined,
    (error: unknown) => errorCode(error),
  );
  expect(refused).toBe(CHECK_VIOLATION);
};

const unique = () => randomUUID().slice(0, 8);

describe('limits in @kanban/shared match the database', () => {
  it('user name', async () => {
    await atLimit(
      (n) =>
        database.db.insert(users).values({
          email: `u${unique()}@t.io`,
          handle: `h${unique()}`,
          name: 'x'.repeat(n),
          passwordHash: 'x',
        }),
      LIMITS.name,
    );
  });

  it('workspace, board and column names', async () => {
    await atLimit(
      (n) => database.db.insert(workspaces).values({ name: 'x'.repeat(n) }),
      LIMITS.name,
    );
    await atLimit(
      (n) =>
        database.db
          .insert(boards)
          .values({ workspaceId: fixture.workspaceId, name: 'x'.repeat(n) }),
      LIMITS.name,
    );
    await atLimit(
      (n) =>
        database.db
          .insert(boardColumns)
          .values({ boardId: fixture.boardId, name: 'x'.repeat(n), position: `p${unique()}` }),
      LIMITS.name,
    );
  });

  const card = (overrides: Partial<typeof cards.$inferInsert>) => ({
    workspaceId: fixture.workspaceId,
    boardId: fixture.boardId,
    columnId: fixture.columnIds[0],
    title: 't',
    position: `c${unique()}`,
    createdBy: fixture.userId,
    ...overrides,
  });

  it('card title', async () => {
    await atLimit(
      (n) => database.db.insert(cards).values(card({ title: 'x'.repeat(n) })),
      LIMITS.cardTitle,
    );
  });

  it('card description', async () => {
    await atLimit(
      (n) => database.db.insert(cards).values(card({ description: 'x'.repeat(n) })),
      LIMITS.cardDescription,
    );
  });

  it('comment body', async () => {
    await atLimit(
      (n) =>
        database.db.insert(comments).values({
          workspaceId: fixture.workspaceId,
          cardId: fixture.cardIds[0] as string,
          authorId: fixture.userId,
          body: 'x'.repeat(n),
        }),
      LIMITS.commentBody,
    );
  });

  const attachment = (overrides: Partial<typeof attachments.$inferInsert>) => ({
    workspaceId: fixture.workspaceId,
    cardId: fixture.cardIds[0] as string,
    uploaderId: fixture.userId,
    objectKey: `k-${randomUUID()}`,
    fileName: 'a.png',
    declaredType: 'image/png',
    sizeBytes: 1,
    ...overrides,
  });

  it('attachment file name', async () => {
    await atLimit(
      (n) => database.db.insert(attachments).values(attachment({ fileName: 'x'.repeat(n) })),
      LIMITS.fileName,
    );
  });

  it('attachment size: exactly 10 MB is stored, one byte more is refused', async () => {
    const insert = (sizeBytes: number) =>
      database.db.insert(attachments).values(attachment({ sizeBytes }));
    await expect(insert(LIMITS.attachmentBytes)).resolves.toBeDefined();
    const refused = await insert(LIMITS.attachmentBytes + 1).then(
      () => undefined,
      (error: unknown) => errorCode(error),
    );
    expect(refused).toBe(CHECK_VIOLATION);
  });

  it('every handle the API accepts is accepted by the database', async () => {
    const handles = ['abc', 'a.b', 'a-b-c', 'a_b', `a${'x'.repeat(30)}b`, '000', 'a1b2c3'];
    for (const handle of handles) {
      expect(HANDLE_PATTERN.test(handle)).toBe(true);
      await expect(
        database.db.insert(users).values({
          email: `${unique()}@t.io`,
          handle,
          name: 'n',
          passwordHash: 'x',
        }),
      ).resolves.toBeDefined();
    }
  });
});
