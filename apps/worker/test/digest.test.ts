import { cards, commentMentions, emailDeliveries } from '@kanban/db';
import { createFixture } from '@kanban/db/testing/fixture';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildDigest } from '../src/jobs/digest';
import {
  harness,
  mailBody,
  mailTo,
  makeUser,
  mention,
  sleep,
  testDb,
  waitFor,
  type Harness,
} from './support/harness';

let h: Harness;
let fixture: Awaited<ReturnType<typeof createFixture>>;

beforeAll(async () => {
  fixture = await createFixture(testDb().db, 3);
});
afterEach(async () => {
  await h.stopAll();
});

const [COLLECT, MIN_INTERVAL] = [1_000, 6_000]; // stand-ins for 60 seconds and 15 minutes
const digestsOf = async (userId: string) =>
  testDb()
    .db.select()
    .from(emailDeliveries)
    .where(and(eq(emailDeliveries.userId, userId), eq(emailDeliveries.kind, 'mention_digest')));

describe('mention digest', () => {
  it('five mentions of one user within a minute become ONE email that lists all five', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await h.start();
    // Spread over 600 ms, inside the collection window. Without a window the first mention alone
    // would be sent as soon as it is noticed, and the rest would wait for the next digest.
    for (let i = 1; i <= 5; i += 1) {
      await mention(fixture, fixture.cardIds[0]!, author, [target], `mention number ${i}`);
      await sleep(150);
    }

    await waitFor(async () => (await mailTo(target.email)).length >= 1, 20_000, 'the digest');
    await sleep(2_500); // more scans happen: nothing else may arrive
    const mails = await mailTo(target.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.Subject).toBe('You were mentioned in 5 comments');
    const body = await mailBody(mails[0]!.ID);
    for (let i = 1; i <= 5; i += 1) expect(body.text).toContain(`mention number ${i}`);
    expect(body.text).toContain(`${fixture.boardId}/cards/${fixture.cardIds[0]}`);

    const claimed = await testDb()
      .db.select()
      .from(commentMentions)
      .where(eq(commentMentions.userId, target.id));
    expect(claimed).toHaveLength(5);
    expect(claimed.every((m) => m.deliveryId !== null)).toBe(true); // each mention belongs to exactly one email
  });

  it('never sends a second digest sooner than the minimum interval, then sends the new mentions in one', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await h.start();

    await mention(fixture, fixture.cardIds[0]!, author, [target], 'first wave');
    await waitFor(
      async () => (await mailTo(target.email)).length === 1,
      20_000,
      'the first digest',
    );
    const firstSentAt = Date.now();

    await mention(fixture, fixture.cardIds[1]!, author, [target], 'second wave a');
    await mention(fixture, fixture.cardIds[2]!, author, [target], 'second wave b');
    await sleep(MIN_INTERVAL - 2_500); // well inside the interval, long after the collection window
    expect(await mailTo(target.email)).toHaveLength(1);
    // the wait is spent waiting, not by running idle jobs over and over
    const idleRuns = h.logs.filter(
      (l) => l.message === 'digest' && l.extra.result === 'too_early',
    ).length;
    expect(idleRuns).toBeLessThanOrEqual(2);

    await waitFor(
      async () => (await mailTo(target.email)).length === 2,
      20_000,
      'the second digest',
    );
    expect(Date.now() - firstSentAt).toBeGreaterThanOrEqual(MIN_INTERVAL - 700);
    const second = (await mailTo(target.email)).find(
      (m) => m.Subject === 'You were mentioned in 2 comments',
    );
    expect(second).toBeDefined();
    const body = await mailBody(second!.ID);
    expect(body.text).toContain('second wave a');
    expect(body.text).not.toContain('first wave'); // already reported
    await sleep(1_500);
    expect(await mailTo(target.email)).toHaveLength(2);
  });

  it('keeps users apart: each gets their own digest, and nobody gets one without a mention', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const author = await makeUser('author');
    const [a, b, bystander] = await Promise.all([
      makeUser('a'),
      makeUser('b'),
      makeUser('bystander'),
    ]);
    await h.start();
    await mention(fixture, fixture.cardIds[0]!, author, [a, b], 'for both');
    await mention(fixture, fixture.cardIds[1]!, author, [a], 'only a');

    await waitFor(
      async () => (await mailTo(a.email)).length === 1 && (await mailTo(b.email)).length === 1,
      20_000,
      'both digests',
    );
    expect((await mailTo(a.email))[0]?.Subject).toBe('You were mentioned in 2 comments');
    expect((await mailTo(b.email))[0]?.Subject).toBe('You were mentioned in 1 comment');
    expect(await mailTo(bystander.email)).toHaveLength(0);
  });

  it('is sent once even with several workers racing for the same user', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await Promise.all([h.start(), h.start(), h.start()]);
    for (let i = 0; i < 4; i += 1)
      await mention(fixture, fixture.cardIds[0]!, author, [target], `racing ${i}`);
    await waitFor(async () => (await mailTo(target.email)).length >= 1, 20_000);
    await sleep(2_500);
    expect(await mailTo(target.email)).toHaveLength(1);
    expect(await digestsOf(target.id)).toHaveLength(1);
  });

  it('building a digest twice at the same moment creates one email, and later calls find nothing to do', async () => {
    h = harness({ digestMinIntervalMs: 1 });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target]);
    const results = await Promise.all([
      buildDigest(h.deps, target.id),
      buildDigest(h.deps, target.id),
      buildDigest(h.deps, target.id),
    ]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await buildDigest(h.deps, target.id)).toBe('nothing');
    expect(await digestsOf(target.id)).toHaveLength(1);
  });

  it('refuses to build a second digest inside the minimum interval even if a job runs early', async () => {
    h = harness({ digestMinIntervalMs: 60_000 });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'first');
    expect(await buildDigest(h.deps, target.id)).toBe('created');

    await mention(fixture, fixture.cardIds[1]!, author, [target], 'second'); // arrives right after
    expect(await buildDigest(h.deps, target.id)).toBe('too_early'); // e.g. a retried or rescheduled job
    expect(await digestsOf(target.id)).toHaveLength(1);
    const waiting = await testDb()
      .db.select()
      .from(commentMentions)
      .where(and(eq(commentMentions.userId, target.id), isNull(commentMentions.deliveryId)));
    expect(waiting).toHaveLength(1); // the new mention is kept for the next digest, not lost

    // once the interval has passed it is picked up
    const later = { ...h.deps, now: () => Date.now() + 61_000 };
    expect(await buildDigest(later, target.id)).toBe('created');
    expect(await digestsOf(target.id)).toHaveLength(2);
  });

  it('ignores mentions on deleted cards, but still reports the others', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const doomed = await createFixture(testDb().db, 2);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(doomed, doomed.cardIds[0]!, author, [target], 'on a card that will be deleted');
    await mention(doomed, doomed.cardIds[1]!, author, [target], 'on a card that stays');
    await testDb()
      .db.update(cards)
      .set({ deletedAt: new Date() })
      .where(eq(cards.id, doomed.cardIds[0]!));
    await h.start();
    await waitFor(async () => (await mailTo(target.email)).length === 1, 20_000);
    const body = await mailBody((await mailTo(target.email))[0]!.ID);
    expect(body.text).toContain('on a card that stays');
    expect(body.text).not.toContain('will be deleted');
  });

  it('after the worker is restarted between building and sending, the email still goes out once', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'built but not yet sent');
    expect(await buildDigest(h.deps, target.id)).toBe('created'); // the email exists in the outbox, nothing has sent it
    expect(await mailTo(target.email)).toHaveLength(0);

    await h.start();
    await waitFor(async () => (await mailTo(target.email)).length === 1, 15_000);
    await sleep(1_500);
    expect(await mailTo(target.email)).toHaveLength(1);
    expect(
      await testDb()
        .db.select()
        .from(commentMentions)
        .where(and(eq(commentMentions.userId, target.id), isNull(commentMentions.deliveryId))),
    ).toHaveLength(0);
  });
});
