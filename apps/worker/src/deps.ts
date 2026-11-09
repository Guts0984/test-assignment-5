import type { S3Client } from '@aws-sdk/client-s3';
import type { Database } from '@kanban/db';

import type { WorkerConfig } from './config';
import type { Mailer } from './mail/mailer';
import type { Queues } from './queues';

/** Everything a job needs, passed in explicitly so tests can substitute any part. */
export type Deps = {
  db: Database;
  s3: S3Client;
  mailer: Mailer;
  config: WorkerConfig;
  queues: Queues;
  now: () => number;
  log: (message: string, extra?: Record<string, unknown>) => void;
};
