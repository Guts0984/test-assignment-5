import { emailDeliveries, workspaceMembers, type Transaction } from '@kanban/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

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

const digestMentionsSchema = z.object({
  mentions: z.array(z.object({ workspaceId: z.string() }).loose()),
});

/**
 * A digest waits in the outbox between being built and being sent (and longer if sending is
 * retried). Whoever was removed from a workspace in that time must not get its comment text, so
 * the mentions are filtered against the memberships as they are right now. Returns the payload to
 * send, or null when nothing is left. A mention without a workspace (written by an older version)
 * cannot be checked and is kept.
 */
const stillAllowed = async (
  tx: Transaction,
  userId: string | null,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const parsed = digestMentionsSchema.safeParse(payload);
  if (!parsed.success) return payload; // not a shape we know: renderDigest rejects it
  if (!userId) return null;
  const memberships = await tx
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const allowed = new Set(memberships.map((row) => row.workspaceId));
  const mentions = parsed.data.mentions.filter((mention) => allowed.has(mention.workspaceId));
  return mentions.length === 0 ? null : { ...payload, mentions };
};

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

    let payload = row.payload;
    if (row.kind === 'mention_digest') {
      const allowed = await stillAllowed(tx, row.userId, row.payload);
      if (!allowed) {
        // The recipient lost access to everything in it: nothing is sent, and the row is closed
        // (and emptied) so it is neither retried nor sent later.
        await tx
          .update(emailDeliveries)
          .set({ status: 'failed', lastError: 'suppressed: recipient lost access', payload: {} })
          .where(eq(emailDeliveries.id, row.id));
        return 'skipped';
      }
      payload = allowed;
    }

    const message = renderFor(row.kind, payload);
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
