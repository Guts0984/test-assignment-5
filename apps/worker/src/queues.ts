import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

import type { WorkerConfig } from './config';

export const QUEUE_NAMES = { mail: 'mail', digest: 'digest', maintenance: 'maintenance' } as const;

/** Sending an email is retried this many times (with growing pauses) before it is given up on. */
export const MAX_SEND_ATTEMPTS = 5;

export const connectionOf = (config: WorkerConfig): ConnectionOptions => ({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
});

export type Queues = { mail: Queue; digest: Queue; maintenance: Queue };

export const createQueues = (config: WorkerConfig): Queues => {
  const options = { connection: connectionOf(config), prefix: config.queuePrefix };
  return {
    mail: new Queue(QUEUE_NAMES.mail, options),
    digest: new Queue(QUEUE_NAMES.digest, options),
    maintenance: new Queue(QUEUE_NAMES.maintenance, options),
  };
};

/**
 * The job id is the delivery id: asking for the same delivery twice while a job for it exists
 * (waiting, delayed or running) adds nothing. BullMQ forbids ":" in ids.
 */
export const sendJobOptions = (config: WorkerConfig, deliveryId: string): JobsOptions => ({
  jobId: deliveryId,
  attempts: MAX_SEND_ATTEMPTS,
  backoff: { type: 'exponential', delay: config.timing.retryBackoffMs },
  removeOnComplete: true,
  removeOnFail: { age: 3_600 },
});

export const digestJobOptions = (userId: string, delayMs: number): JobsOptions => ({
  jobId: `digest-${userId}`,
  delay: Math.max(0, Math.round(delayMs)),
  removeOnComplete: true,
  removeOnFail: true,
});
