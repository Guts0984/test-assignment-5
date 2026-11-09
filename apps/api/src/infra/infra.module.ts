import { S3Client } from '@aws-sdk/client-s3';
import { createDatabase, postgresUrl, type DatabaseHandle } from '@kanban/db';
import {
  Global,
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE, REDIS, S3, S3_SIGNER } from './tokens';

/**
 * Connections to PostgreSQL, Redis and S3. Each one has timeouts and an error listener:
 * losing a dependency must make requests fail fast (and /ready report it), never crash the
 * process, and the clients reconnect on their own when it comes back.
 */
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  static register(config: AppConfig): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DATABASE,
          useFactory: (): DatabaseHandle => {
            const logger = new Logger('Postgres');
            return createDatabase({
              url: postgresUrl(config.postgres),
              applicationName: 'kanban-api',
              maxConnections: 10,
              connectTimeoutMs: 3_000,
              statementTimeoutMs: 10_000,
              onError: (error) => logger.warn(`connection error: ${error.message}`),
            });
          },
        },
        {
          provide: REDIS,
          useFactory: async (): Promise<Redis> => {
            const logger = new Logger('Redis');
            const redis = new Redis({
              host: config.redis.host,
              port: config.redis.port,
              password: config.redis.password,
              connectTimeout: 2_000,
              commandTimeout: 2_000,
              // Fail commands immediately while disconnected instead of queueing them forever.
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
              retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
            });
            redis.on('error', (error) => logger.warn(`connection error: ${error.message}`));
            // Give the first connection a moment so the first requests are not served without
            // rate limiting. If Redis is down we start anyway: /ready reports it and the client
            // keeps retrying in the background.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_000);
              redis.once('ready', () => {
                clearTimeout(timer);
                resolve();
              });
            });
            return redis;
          },
        },
        {
          // Signatures cover the host name, so links for browsers must be signed for the address
          // browsers use (nginx), not the internal one.
          provide: S3_SIGNER,
          useFactory: (): S3Client =>
            new S3Client({
              region: config.s3.region,
              endpoint: config.s3.publicUrl,
              forcePathStyle: true,
              credentials: {
                accessKeyId: config.s3.accessKey,
                secretAccessKey: config.s3.secretKey,
              },
            }),
        },
        {
          provide: S3,
          useFactory: (): S3Client =>
            new S3Client({
              region: config.s3.region,
              endpoint: config.s3.endpoint,
              forcePathStyle: true,
              credentials: {
                accessKeyId: config.s3.accessKey,
                secretAccessKey: config.s3.secretKey,
              },
              maxAttempts: 2,
              requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
            }),
        },
      ],
      exports: [APP_CONFIG, DATABASE, REDIS, S3, S3_SIGNER],
    };
  }

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.database.close(),
      this.redis.quit(),
      Promise.resolve(this.s3.destroy()),
    ]);
    this.redis.disconnect();
  }
}
