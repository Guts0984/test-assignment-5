import { emailDeliveries } from '@kanban/db';
import { asc, eq } from 'drizzle-orm';

import type { Deps } from '../deps';
import { sendJobOptions } from '../queues';

const BATCH = 200;

/**
 * Finds emails that are waiting in the outbox and puts one send job per email on the queue. Safe
 * to run as often as you like, from any number of workers: the job id is the delivery id, so a
 * delivery that already has a job is not queued twice.
 */
export const scanOutbox = async (deps: Deps): Promise<number> => {
  const pending = await deps.db
    .select({ id: emailDeliveries.id })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.status, 'pending'))
    .orderBy(asc(emailDeliveries.createdAt))
    .limit(BATCH);
  await Promise.all(
    pending.map((row) =>
      deps.queues.mail.add('send', { deliveryId: row.id }, sendJobOptions(deps.config, row.id)),
    ),
  );
  return pending.length;
};
