import { Worker } from 'bullmq';

import type { Deps } from './deps';
import { cleanup } from './jobs/cleanup';
import { buildDigest, scanMentions } from './jobs/digest';
import { scanOutbox } from './jobs/outbox';
import { sendDelivery } from './jobs/send-email';
import { connectionOf, QUEUE_NAMES } from './queues';

export type RunningWorker = {
  /** Stops taking new jobs, lets the running ones finish, then closes every connection of the queue. */
  stop: () => Promise<void>;
};

const idOf = (value: unknown, key: string): string => {
  const id = (value as Record<string, unknown> | null)?.[key];
  if (typeof id !== 'string') throw new Error(`job data is missing "${key}"`);
  return id;
};

/**
 * Starts consuming. Everything periodic is a BullMQ job scheduler (not a timer in this process),
 * so it keeps running exactly once per interval however many workers are started, and survives
 * restarts: the schedule lives in Redis.
 */
export const startWorker = async (deps: Deps): Promise<RunningWorker> => {
  const { config } = deps;
  const options = { connection: connectionOf(config), prefix: config.queuePrefix };

  const workers = [
    new Worker(
      QUEUE_NAMES.mail,
      async (job) => {
        const result = await sendDelivery(deps, idOf(job.data, 'deliveryId'));
        if (result === 'retry') throw new Error('sending failed, will retry');
      },
      { ...options, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.digest,
      async (job) => {
        const result = await buildDigest(deps, idOf(job.data, 'userId'));
        deps.log('digest', { result });
      },
      { ...options, concurrency: 5 },
    ),
    new Worker(
      QUEUE_NAMES.maintenance,
      async (job) => {
        if (job.name === 'scan-outbox') await scanOutbox(deps);
        else if (job.name === 'scan-mentions') await scanMentions(deps);
        else if (job.name === 'cleanup') deps.log('cleanup', { ...(await cleanup(deps)) });
      },
      { ...options, concurrency: 1 },
    ),
  ];
  for (const worker of workers) {
    // Without a listener an 'error' event would be thrown as an uncaught exception.
    worker.on('error', (error) => deps.log('worker error', { error: error.message }));
    worker.on('failed', (job, error) =>
      deps.log('job failed', { job: job?.name, error: error.message }),
    );
  }

  const schedule = { removeOnComplete: true, removeOnFail: true } as const;
  await Promise.all([
    deps.queues.maintenance.upsertJobScheduler(
      'scan-outbox',
      { every: config.timing.scanIntervalMs },
      { name: 'scan-outbox', opts: schedule },
    ),
    deps.queues.maintenance.upsertJobScheduler(
      'scan-mentions',
      { every: config.timing.scanIntervalMs },
      { name: 'scan-mentions', opts: schedule },
    ),
    deps.queues.maintenance.upsertJobScheduler(
      'cleanup',
      { every: config.timing.cleanupIntervalMs },
      { name: 'cleanup', opts: schedule },
    ),
  ]);

  return {
    stop: async () => {
      await Promise.all(workers.map((worker) => worker.close())); // waits for jobs that are running
      await Promise.all(Object.values(deps.queues).map((queue) => queue.close()));
    },
  };
};
