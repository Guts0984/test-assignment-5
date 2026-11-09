import { emailDeliveries } from '@kanban/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { sendDelivery } from '../src/jobs/send-email';
import {
  harness,
  mailBody,
  mailTo,
  queueInvite,
  sleep,
  testDb,
  uniqueEmail,
  waitFor,
  type Harness,
} from './support/harness';

let h: Harness;
afterEach(async () => {
  await h.stopAll();
});

const row = async (id: string) =>
  (await testDb().db.select().from(emailDeliveries).where(eq(emailDeliveries.id, id)))[0]!;

describe('invitation emails', () => {
  it('are sent once from the outbox, then the row is marked sent and the secret link is erased', async () => {
    h = harness();
    const to = uniqueEmail('invitee');
    const delivery = await queueInvite(to);
    await h.start();

    await waitFor(async () => (await mailTo(to)).length === 1, 15_000, 'the email');
    const [message] = await mailTo(to);
    expect(message?.Subject).toBe('Alice invited you to Acme');
    const body = await mailBody(message!.ID);
    expect(body.text).toContain('http://localhost:8080/invite/secret-token-value');
    expect(body.messageId).toBe(`${delivery.id}@kanban.local`);

    await waitFor(
      async () => (await row(delivery.id)).status === 'sent',
      5_000,
      'the row to be marked sent',
    );
    const stored = await row(delivery.id);
    expect(stored).toMatchObject({ attempts: 1, lastError: null });
    expect(stored.payload).toEqual({}); // the secret accept link is gone from the database
    expect(JSON.stringify(stored)).not.toContain('secret-token-value');
    expect(stored.sentAt).not.toBeNull();

    await sleep(1_500); // keeps scanning every 200 ms: nothing more may arrive
    expect(await mailTo(to)).toHaveLength(1);
  });

  it('shows names as text: a workspace called <script> cannot inject markup into the email', async () => {
    h = harness();
    const to = uniqueEmail('xss');
    await queueInvite(to, { workspaceName: '<script>alert(1)</script>' });
    await h.start();
    await waitFor(async () => (await mailTo(to)).length === 1);
    const body = await mailBody((await mailTo(to))[0]!.ID);
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('are sent exactly once even if several workers run at the same time', async () => {
    h = harness();
    const recipients = Array.from({ length: 12 }, (_, i) => uniqueEmail(`race${i}`));
    for (const to of recipients) await queueInvite(to);
    await Promise.all([h.start(), h.start(), h.start()]); // three worker processes on the same queues

    await waitFor(
      async () => (await Promise.all(recipients.map(mailTo))).every((mails) => mails.length >= 1),
      20_000,
      'all emails',
    );
    await sleep(1_500);
    for (const to of recipients) expect(await mailTo(to), to).toHaveLength(1);
  });

  it('survive a restart: waiting emails go out after it, sent ones are never sent again', async () => {
    h = harness();
    const first = uniqueEmail('before');
    await queueInvite(first);
    const w1 = await h.start();
    await waitFor(async () => (await mailTo(first)).length === 1);
    await w1.stop(); // the worker goes away...

    const second = uniqueEmail('during');
    await queueInvite(second); // ...an email is queued while nothing is running...
    await sleep(800);
    expect(await mailTo(second)).toHaveLength(0);

    await h.start(); // ...a new worker starts
    await waitFor(async () => (await mailTo(second)).length === 1, 15_000, 'the queued email');
    await sleep(1_500);
    expect(await mailTo(first)).toHaveLength(1); // not repeated
    expect(await mailTo(second)).toHaveLength(1);
  });

  it('are never sent twice by calling the sender again, at once or later', async () => {
    h = harness();
    const to = uniqueEmail('direct');
    const delivery = await queueInvite(to);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sendDelivery(h.deps, delivery.id)),
    );
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(await sendDelivery(h.deps, delivery.id)).toBe('skipped');
    await sleep(500);
    expect(await mailTo(to)).toHaveLength(1);
  });
});

describe('when the mail server fails', () => {
  it('retries with growing pauses and sends once it recovers, counting every attempt', async () => {
    let calls = 0;
    const real = harness().deps.mailer;
    h = harness({}, async (mail) => {
      calls += 1;
      if (calls <= 2) throw new Error('smtp is down');
      await real(mail);
    });
    const to = uniqueEmail('flaky');
    const delivery = await queueInvite(to);
    await h.start();

    await waitFor(async () => (await mailTo(to)).length === 1, 20_000, 'the email after retries');
    await waitFor(async () => (await row(delivery.id)).status === 'sent');
    expect(await row(delivery.id)).toMatchObject({ attempts: 3, lastError: null });
    await sleep(1_000);
    expect(await mailTo(to)).toHaveLength(1);
  });

  it('gives up after five attempts, keeps the reason, and never sends a failed email later', async () => {
    h = harness({}, () => Promise.reject(new Error('smtp is down for good')));
    const to = uniqueEmail('hopeless');
    const delivery = await queueInvite(to);
    await h.start();
    await waitFor(
      async () => (await row(delivery.id)).status === 'failed',
      30_000,
      'the row to be marked failed',
    );
    expect(await row(delivery.id)).toMatchObject({
      attempts: 5,
      lastError: 'smtp is down for good',
    });
    await h.stopAll();

    // The server is fine again and a new worker starts: the failed email stays failed.
    h = harness();
    await h.start();
    await sleep(1_500);
    expect(await mailTo(to)).toHaveLength(0);
    expect((await row(delivery.id)).status).toBe('failed');
  });

  it('marks a row it cannot render as failed instead of looping on it or crashing', async () => {
    h = harness();
    const delivery = await queueInvite(uniqueEmail('broken'), { link: 'not a url' });
    const healthy = uniqueEmail('healthy');
    await queueInvite(healthy);
    await h.start();
    await waitFor(async () => (await row(delivery.id)).status === 'failed');
    await waitFor(async () => (await mailTo(healthy)).length === 1); // the worker kept going
    expect((await row(delivery.id)).lastError).toBe('unsendable payload');
  });

  it('an unreachable SMTP server fails fast instead of hanging the worker', async () => {
    const { createMailer } = await import('../src/mail/mailer');
    const mailer = createMailer({ host: '127.0.0.1', port: 1, from: 'x@y.z' });
    const started = Date.now();
    await expect(
      mailer({ to: 'a@b.c', subject: 's', text: 't', html: 'h', messageId: '<id@x>' }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});
