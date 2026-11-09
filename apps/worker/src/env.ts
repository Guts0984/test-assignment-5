import { describeEnvProblems, readDotEnv } from '@kanban/env';
import { z } from 'zod';

import type { WorkerConfig } from './config';

/**
 * The single gate between the `.env` file and the worker (see packages/env). Secrets have no
 * defaults: a missing one stops the process at startup with a message naming the variable.
 */
const port = z.coerce.number().int().min(1).max(65535);
const positive = z.coerce.number().int().min(1);

const schema = z.object({
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: port.default(5432),

  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: port.default(6379),
  REDIS_PASSWORD: z.string().min(1),

  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  S3_ENDPOINT: z.url().default('http://127.0.0.1:9000'),
  S3_BUCKET: z.string().min(3).default('kanban-files'),
  S3_REGION: z.string().min(1).default('us-east-1'),

  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: port.default(1025),
  MAIL_FROM: z.string().min(3).default('Kanban <no-reply@kanban.local>'),
  APP_ORIGIN: z.url().default('http://localhost:8080'),

  WORKER_HEALTH_PORT: port.default(3002),
  SCAN_INTERVAL_SECONDS: positive.default(2),
  CLEANUP_INTERVAL_SECONDS: positive.default(60),
  // Mentions within this time of the first one are collected into one digest.
  DIGEST_COLLECT_SECONDS: positive.default(60),
  // A user gets at most one digest per this time: 15 minutes (assignment requirement).
  DIGEST_MIN_INTERVAL_SECONDS: positive.default(15 * 60),
  // Uploads that were never completed are removed after one hour (assignment requirement).
  UPLOAD_MAX_AGE_SECONDS: positive.default(60 * 60),
});

const load = (): WorkerConfig => {
  const result = schema.safeParse(readDotEnv());
  if (!result.success) throw new Error(`Invalid .env: ${describeEnvProblems(result.error.issues)}`);
  const v = result.data;
  return {
    postgres: {
      user: v.POSTGRES_USER,
      password: v.POSTGRES_PASSWORD,
      database: v.POSTGRES_DB,
      host: v.POSTGRES_HOST,
      port: v.POSTGRES_PORT,
    },
    redis: { host: v.REDIS_HOST, port: v.REDIS_PORT, password: v.REDIS_PASSWORD },
    s3: {
      endpoint: v.S3_ENDPOINT,
      bucket: v.S3_BUCKET,
      region: v.S3_REGION,
      accessKey: v.MINIO_ROOT_USER,
      secretKey: v.MINIO_ROOT_PASSWORD,
    },
    smtp: { host: v.SMTP_HOST, port: v.SMTP_PORT, from: v.MAIL_FROM },
    appOrigin: new URL(v.APP_ORIGIN).origin,
    healthPort: v.WORKER_HEALTH_PORT,
    queuePrefix: 'kanban',
    timing: {
      scanIntervalMs: v.SCAN_INTERVAL_SECONDS * 1000,
      cleanupIntervalMs: v.CLEANUP_INTERVAL_SECONDS * 1000,
      digestCollectMs: v.DIGEST_COLLECT_SECONDS * 1000,
      digestMinIntervalMs: v.DIGEST_MIN_INTERVAL_SECONDS * 1000,
      uploadMaxAgeMs: v.UPLOAD_MAX_AGE_SECONDS * 1000,
      retryBackoffMs: 5_000,
    },
  };
};

export const config = load();
