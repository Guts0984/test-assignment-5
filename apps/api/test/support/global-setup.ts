import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { startTestDatabase } from '@kanban/db/testing';
import { MinioContainer } from '@testcontainers/minio';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

export type InfraInfo = {
  postgres: { host: string; port: number; user: string; password: string; database: string };
  redis: { host: string; port: number; password: string };
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
};

declare module 'vitest' {
  export interface ProvidedContext {
    infra: InfraInfo;
  }
}

const REDIS_PASSWORD = 'test-redis-password';
const BUCKET = 'test-bucket';
// MinIO no longer publishes images; this is the maintained community fork (see README).
const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z';

/** Starts one PostgreSQL (migrated), one Redis and one MinIO for every test file to share. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [database, redis, minio] = await Promise.all([
    startTestDatabase(),
    new RedisContainer('redis:7-alpine').withPassword(REDIS_PASSWORD).start(),
    new MinioContainer(MINIO_IMAGE).start(),
  ]);

  const endpoint = minio.getConnectionUrl();
  await new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
  }).send(new CreateBucketCommand({ Bucket: BUCKET }));

  const pg = new URL(database.url);
  project.provide('infra', {
    postgres: {
      host: pg.hostname,
      port: Number(pg.port),
      user: decodeURIComponent(pg.username),
      password: decodeURIComponent(pg.password),
      database: pg.pathname.slice(1),
    },
    redis: { host: redis.getHost(), port: redis.getPort(), password: REDIS_PASSWORD },
    s3: {
      endpoint,
      accessKey: minio.getUsername(),
      secretKey: minio.getPassword(),
      bucket: BUCKET,
    },
  });

  return async () => {
    await Promise.all([database.stop(), redis.stop(), minio.stop()]);
  };
}
