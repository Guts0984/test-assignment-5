import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { attachments, cards } from '@kanban/db';
import { createFixture } from '@kanban/db/testing/fixture';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { cleanup } from '../src/jobs/cleanup';
import { harness, testDb, testS3, waitFor, type Harness } from './support/harness';

let h: Harness;
let fixture: Awaited<ReturnType<typeof createFixture>>;
const HOUR = 60 * 60 * 1000;
const Bucket = () => inject('infra').s3.bucket;

beforeAll(async () => {
  fixture = await createFixture(testDb().db, 4);
});
afterEach(async () => {
  await h.stopAll();
});

/** An attachment row with a real object in storage; `ageMs` backdates its creation. */
const makeAttachment = async (
  cardId: string,
  status: 'pending' | 'ready',
  ageMs: number,
  owner: { workspaceId: string; userId: string } = fixture,
) => {
  const objectKey = `${owner.workspaceId}/${cardId}/${randomUUID()}`;
  await testS3().send(
    new PutObjectCommand({ Bucket: Bucket(), Key: objectKey, Body: Buffer.from('file contents') }),
  );
  const [row] = await testDb()
    .db.insert(attachments)
    .values({
      workspaceId: owner.workspaceId,
      cardId,
      uploaderId: owner.userId,
      objectKey,
      fileName: 'f.png',
      declaredType: 'image/png',
      detectedType: status === 'ready' ? 'image/png' : null,
      sizeBytes: 13,
      status,
      completedAt: status === 'ready' ? new Date() : null,
      createdAt: new Date(Date.now() - ageMs),
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row;
};

const objectExists = (key: string) =>
  testS3()
    .send(new HeadObjectCommand({ Bucket: Bucket(), Key: key }))
    .then(
      () => true,
      () => false,
    );
const rowExists = async (id: string) =>
  (await testDb().db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, id)))
    .length === 1;

describe('unfinished uploads', () => {
  it('older than an hour are removed from storage and the database; younger ones are left alone', async () => {
    h = harness();
    const stale = await makeAttachment(fixture.cardIds[0]!, 'pending', HOUR + 60_000);
    const fresh = await makeAttachment(fixture.cardIds[0]!, 'pending', HOUR - 5 * 60_000);
    const done = await makeAttachment(fixture.cardIds[0]!, 'ready', 5 * HOUR); // completed files are never "stale"

    const result = await cleanup(h.deps);
    expect(result.staleUploads).toBeGreaterThanOrEqual(1);
    expect(await objectExists(stale.objectKey)).toBe(false);
    expect(await rowExists(stale.id)).toBe(false);
    expect(await objectExists(fresh.objectKey)).toBe(true);
    expect(await rowExists(fresh.id)).toBe(true);
    expect(await objectExists(done.objectKey)).toBe(true);
    expect(await rowExists(done.id)).toBe(true);
  });

  it('use the exact one-hour boundary', async () => {
    h = harness();
    const justOver = await makeAttachment(fixture.cardIds[1]!, 'pending', HOUR + 5_000);
    const justUnder = await makeAttachment(fixture.cardIds[1]!, 'pending', HOUR - 5_000);
    await cleanup(h.deps);
    expect(await rowExists(justOver.id)).toBe(false);
    expect(await rowExists(justUnder.id)).toBe(true);
  });

  it('are processed completely even when there are far more than one batch', async () => {
    h = harness();
    const many = await Promise.all(
      Array.from({ length: 130 }, () => makeAttachment(fixture.cardIds[2]!, 'pending', 2 * HOUR)),
    );
    await cleanup(h.deps);
    const left = await testDb()
      .db.select({ id: attachments.id })
      .from(attachments)
      .where(
        inArray(
          attachments.id,
          many.map((a) => a.id),
        ),
      );
    expect(left).toEqual([]);
    expect(await objectExists(many[129]!.objectKey)).toBe(false);
  }, 120_000);
});

describe('files of deleted cards', () => {
  it('are removed (object and row) while the card itself stays', async () => {
    h = harness();
    const doomed = await createFixture(testDb().db, 1);
    const doomedCard = doomed.cardIds[0]!;
    const file = await makeAttachment(doomedCard, 'ready', 0, doomed);
    const keptFile = await makeAttachment(fixture.cardIds[3]!, 'ready', 0); // belongs to a live card

    await cleanup(h.deps);
    expect(await objectExists(file.objectKey)).toBe(true); // its card is alive: untouched

    await testDb().db.update(cards).set({ deletedAt: new Date() }).where(eq(cards.id, doomedCard));
    const result = await cleanup(h.deps);
    expect(result.deletedCardFiles).toBeGreaterThanOrEqual(1);
    expect(await objectExists(file.objectKey)).toBe(false);
    expect(await rowExists(file.id)).toBe(false);
    expect(
      (await testDb().db.select({ id: cards.id }).from(cards).where(eq(cards.id, doomedCard)))
        .length,
    ).toBe(1); // history kept
    expect(await objectExists(keptFile.objectKey)).toBe(true); // files of live cards are never touched
  });
});

describe('robustness', () => {
  it('can run again and again, and a file that is already gone from storage is not an error', async () => {
    h = harness();
    const stale = await makeAttachment(fixture.cardIds[0]!, 'pending', 2 * HOUR);
    await testS3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: stale.objectKey })); // gone already
    await cleanup(h.deps);
    expect(await rowExists(stale.id)).toBe(false); // the dangling row is still cleaned up
    const again = await cleanup(h.deps);
    expect(again).toEqual({ staleUploads: 0, deletedCardFiles: 0 });
  });

  it('one file that cannot be deleted does not stop the others, and is retried next time', async () => {
    h = harness();
    const [bad, good] = await Promise.all([
      makeAttachment(fixture.cardIds[0]!, 'pending', 2 * HOUR),
      makeAttachment(fixture.cardIds[0]!, 'pending', 2 * HOUR),
    ]);
    const real = h.deps.s3;
    // storage that refuses to delete exactly one object
    const flakyStorage = {
      send: (command: DeleteObjectCommand) =>
        command.input.Key === bad.objectKey
          ? Promise.reject(new Error('storage hiccup'))
          : real.send(command),
    } as unknown as S3Client;
    const flaky = { ...h.deps, s3: flakyStorage };
    await cleanup(flaky);
    expect(await rowExists(good.id)).toBe(false);
    expect(await rowExists(bad.id)).toBe(true); // kept, so nothing is orphaned
    expect(await objectExists(bad.objectKey)).toBe(true);

    await cleanup(h.deps); // storage is fine again
    expect(await rowExists(bad.id)).toBe(false);
    expect(await objectExists(bad.objectKey)).toBe(false);
  });

  it('runs by itself on a schedule once the worker is started', async () => {
    h = harness({ cleanupIntervalMs: 300 });
    const stale = await makeAttachment(fixture.cardIds[0]!, 'pending', 2 * HOUR);
    await h.start();
    await waitFor(async () => !(await rowExists(stale.id)), 15_000, 'the scheduled cleanup');
    expect(await objectExists(stale.objectKey)).toBe(false);
  });
});
