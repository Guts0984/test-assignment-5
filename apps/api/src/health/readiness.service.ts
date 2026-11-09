import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DatabaseHandle } from '@kanban/db';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE, REDIS, S3 } from '../infra/tokens';

export type DependencyStatus = 'up' | 'down';
export type Readiness = {
  ready: boolean;
  checks: Record<'postgres' | 'redis' | 's3', DependencyStatus>;
};

const CHECK_TIMEOUT_MS = 2_000;

const within = async (check: () => Promise<unknown>): Promise<DependencyStatus> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
};

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<Readiness> {
    const [postgres, redis, s3] = await Promise.all([
      within(() => this.database.pool.query('select 1')),
      within(() => this.redis.ping()),
      within(() => this.s3.send(new HeadBucketCommand({ Bucket: this.config.s3.bucket }))),
    ]);
    const checks = { postgres, redis, s3 };
    return { ready: Object.values(checks).every((status) => status === 'up'), checks };
  }
}
