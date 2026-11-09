import { emailDeliveries } from '@kanban/db';
import { and, eq } from 'drizzle-orm';

import type { Deps } from '../deps';
import { renderDigest, renderInvite, type RenderedMail } from '../mail/render';
import { MAX_SEND_ATTEMPTS } from '../queues';

export type SendResult = 'sent' | 'skipped' | 'failed' | 'retry';

const renderFor = (kind: string, payload: unknown): RenderedMail | null =>
  kind === 'invite'
    ? renderInvite(payload)
    : kind === 'mention_digest'
      ? renderDigest(payload)
      : null;

/**
 * Sends ONE email from the outbox, at most once per delivery.
 *
 * The row is locked (`FOR UPDATE SKIP LOCKED`) for the whole attempt: a second worker, a retried
 * job or a job that survived a restart finds it locked or already `sent` and does nothing. Only
 * a crash in the few milliseconds between the SMTP server accepting the message and the row being
 * marked `sent` can lead to a second copy; the stable Message-ID lets receivers recognise it.
 *
 * Once sent, the payload is cleared: for invitations it held the secret accept link.
 */
export const sendDelivery = async (deps: Deps, deliveryId: string): Promise<SendResult> => {
  const result = await deps.db.transaction(async (tx): Promise<SendResult> => {
    const [row] = await tx
      .select()
      .from(emailDeliveries)
      .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.status, 'pending')))
      .for('update', { skipLocked: true })
      .limit(1);
    if (!row) return 'skipped';

    const message = renderFor(row.kind, row.payload);
    if (!message) {
      await tx
        .update(emailDeliveries)
        .set({ status: 'failed', lastError: 'unsendable payload' })
        .where(eq(emailDeliveries.id, row.id));
      return 'failed';
    }

    try {
      await deps.mailer({ ...message, to: row.toEmail, messageId: `<${row.id}@kanban.local>` });
    } catch (error) {
      const attempts = row.attempts + 1;
      const final = attempts >= MAX_SEND_ATTEMPTS;
      await tx
        .update(emailDeliveries)
        .set({
          attempts,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          status: final ? 'failed' : 'pending',
        })
        .where(eq(emailDeliveries.id, row.id));
      return final ? 'failed' : 'retry';
    }

    await tx
      .update(emailDeliveries)
      .set({
        status: 'sent',
        sentAt: new Date(deps.now()),
        attempts: row.attempts + 1,
        lastError: null,
        payload: {},
      })
      .where(eq(emailDeliveries.id, row.id));
    return 'sent';
  });
  if (result === 'sent') deps.log('email sent', { deliveryId });
  return result;
};
