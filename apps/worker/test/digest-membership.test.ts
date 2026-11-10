import { commentMentions, emailDeliveries } from '@kanban/db';
import { createFixture } from '@kanban/db/testing/fixture';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDigest } from '../src/jobs/digest';
import {
  harness,
  join,
  mailBody,
  mailTo,
  makeUser,
  mention,
  removeMember,
  sleep,
  testDb,
  waitFor,
  type Harness,
} from './support/harness';

let h: Harness;
afterEach(async () => {
  await h.stopAll();
});

const [COLLECT, MIN_INTERVAL] = [1_000, 6_000];
const deliveriesOf = (userId: string) =>
  testDb().db.select().from(emailDeliveries).where(eq(emailDeliveries.userId, userId));
const unclaimedOf = (userId: string) =>
  testDb()
    .db.select()
    .from(commentMentions)
    .where(and(eq(commentMentions.userId, userId), isNull(commentMentions.deliveryId)));

describe('mention digest and workspace membership', () => {
  it('a member removed before the digest is built gets no email and no outbox row', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const fixture = await createFixture(testDb().db, 1);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'secret plan of workspace A');
    await removeMember(fixture.workspaceId, target);

    await h.start();
    await sleep(COLLECT + 2_500); // the collection window and several scans pass
    expect(await mailTo(target.email)).toHaveLength(0);
    expect(await deliveriesOf(target.id)).toHaveLength(0);
    expect(await buildDigest(h.deps, target.id)).toBe('nothing');
  });

  it('removal during the collection window (after the mention, before the send) sends nothing', async () => {
    h = harness({ digestCollectMs: 2_000, digestMinIntervalMs: MIN_INTERVAL });
    const fixture = await createFixture(testDb().db, 1);
    const author = await makeUser('author');
    const target = await makeUser('target');
    const other = await makeUser('other');
    await h.start();
    await mention(fixture, fixture.cardIds[0]!, author, [target, other], 'removed before sending');
    await sleep(500); // the digest job is already scheduled
    await removeMember(fixture.workspaceId, target);

    // the control: somebody who stays gets the same digest, so "no mail" means the filter, not a slow worker
    await waitFor(async () => (await mailTo(other.email)).length === 1, 20_000, 'control digest');
    await sleep(1_000);
    expect(await mailTo(target.email)).toHaveLength(0);
  });

  it('removal after the digest was built but before it is sent: the email is not sent', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const fixture = await createFixture(testDb().db, 1);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'built, then removed');
    expect(await buildDigest(h.deps, target.id)).toBe('created'); // waits in the outbox
    await removeMember(fixture.workspaceId, target);

    await h.start();
    await waitFor(
      async () => (await deliveriesOf(target.id)).every((d) => d.status !== 'pending'),
      15_000,
      'the outbox row to be handled',
    );
    await sleep(1_000);
    expect(await mailTo(target.email)).toHaveLength(0);
    const [row] = await deliveriesOf(target.id);
    expect(row?.status).toBe('failed'); // handled, so it is not retried or sent later
    expect(row?.payload).toEqual({}); // the comment text is not kept either
  });

  it('removed from workspace A but still in B: the digest keeps B and drops A', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const [a, b] = await Promise.all([
      createFixture(testDb().db, 1),
      createFixture(testDb().db, 1),
    ]);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(a, a.cardIds[0]!, author, [target], 'text from workspace A');
    await mention(b, b.cardIds[0]!, author, [target], 'text from workspace B');
    await removeMember(a.workspaceId, target);

    await h.start();
    await waitFor(async () => (await mailTo(target.email)).length === 1, 20_000, 'the digest');
    await sleep(1_500);
    const mails = await mailTo(target.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.Subject).toBe('You were mentioned in 1 comment');
    const body = await mailBody(mails[0]!.ID);
    expect(body.text).toContain('text from workspace B');
    expect(body.text + body.html).not.toContain('workspace A');
    expect(body.text + body.html).not.toContain(a.boardId);
    expect(await unclaimedOf(target.id)).toHaveLength(1); // A's mention is never claimed by any email
  });

  it('partial removal between build and send drops only the removed workspace from the email', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const [a, b] = await Promise.all([
      createFixture(testDb().db, 1),
      createFixture(testDb().db, 1),
    ]);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(a, a.cardIds[0]!, author, [target], 'late text from A');
    await mention(b, b.cardIds[0]!, author, [target], 'late text from B');
    expect(await buildDigest(h.deps, target.id)).toBe('created');
    await removeMember(a.workspaceId, target);

    await h.start();
    await waitFor(async () => (await mailTo(target.email)).length === 1, 15_000, 'the email');
    const mails = await mailTo(target.email);
    expect(mails[0]?.Subject).toBe('You were mentioned in 1 comment');
    const body = await mailBody(mails[0]!.ID);
    expect(body.text).toContain('late text from B');
    expect(body.text + body.html).not.toContain('late text from A');
  });

  it('a member who is removed and added back does not receive mentions from before the re-join', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: MIN_INTERVAL });
    const fixture = await createFixture(testDb().db, 2);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'from the first membership');
    await removeMember(fixture.workspaceId, target);
    await sleep(50);
    await join(fixture.workspaceId, target); // invited again
    await sleep(50);
    await mention(fixture, fixture.cardIds[1]!, author, [target], 'after the second join');

    await h.start();
    await waitFor(async () => (await mailTo(target.email)).length === 1, 20_000, 'the digest');
    await sleep(1_500);
    const mails = await mailTo(target.email);
    expect(mails).toHaveLength(1);
    const body = await mailBody(mails[0]!.ID);
    expect(body.text).toContain('after the second join');
    expect(body.text).not.toContain('from the first membership');
  });

  it('when every mention is filtered nothing is scheduled, retried or sent later', async () => {
    h = harness({ digestCollectMs: COLLECT, digestMinIntervalMs: 1 });
    const fixture = await createFixture(testDb().db, 1);
    const author = await makeUser('author');
    const target = await makeUser('target');
    await mention(fixture, fixture.cardIds[0]!, author, [target], 'never to be delivered');
    await removeMember(fixture.workspaceId, target);
    await h.start();
    await sleep(COLLECT + 2_000);
    const digestJobs = await h.deps.queues.digest.getJobCounts(
      'delayed',
      'waiting',
      'active',
      'failed',
    );
    expect(digestJobs).toEqual({ delayed: 0, waiting: 0, active: 0, failed: 0 });
    expect(await mailTo(target.email)).toHaveLength(0);
  });
});
