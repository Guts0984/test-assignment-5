import { describeEnvProblems, readDotEnv } from '@kanban/env';
import { z } from 'zod';

import type { AppConfig } from './config';

/**
 * The single gate between the `.env` file and the API (see packages/env for how the file is
 * found). Secrets have no defaults: a missing one stops the process at startup with a message
 * naming the variable. Defaults exist only for public, non-sensitive values.
 */
const port = z.coerce.number().int().min(1).max(65535);

const schema = z.object({
  PORT: port.default(3001),
  APP_ORIGIN: z.url().default('http://localhost:8080'),
  // Set to true when the site is served over HTTPS (browsers refuse Secure cookies on http).
  COOKIE_SECURE: z.stringbool().default(false),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),
  INVITE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),

  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: port.default(5432),

  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: port.default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // MinIO root credentials, shared with the MinIO container.
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  S3_ENDPOINT: z.url().default('http://127.0.0.1:9000'),
  S3_PUBLIC_URL: z.url().default('http://localhost:8080'),
  S3_BUCKET: z.string().min(3).default('kanban-files'),
  S3_REGION: z.string().min(1).default('us-east-1'),

  // Signed download links live five minutes (assignment requirement).
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),

  // Secret: vouches for the visitor address on calls from the Next.js server. No default.
  CLIENT_IP_SECRET: z.string().min(16),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  WS_CONNECTS_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  WS_MESSAGES_PER_10S: z.coerce.number().int().min(1).default(600),
  WS_JOINS_PER_10S: z.coerce.number().int().min(1).default(30),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).default(20),
});

const load = (): AppConfig => {
  const result = schema.safeParse(readDotEnv());
  if (!result.success) throw new Error(`Invalid .env: ${describeEnvProblems(result.error.issues)}`);
  const v = result.data;
  return {
    port: v.PORT,
    appOrigin: new URL(v.APP_ORIGIN).origin,
    session: { cookieSecure: v.COOKIE_SECURE, ttlSeconds: v.SESSION_TTL_SECONDS },
    inviteTtlSeconds: v.INVITE_TTL_SECONDS,
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
      publicUrl: v.S3_PUBLIC_URL,
      bucket: v.S3_BUCKET,
      region: v.S3_REGION,
      accessKey: v.MINIO_ROOT_USER,
      secretKey: v.MINIO_ROOT_PASSWORD,
    },
    downloadLinkTtlSeconds: v.DOWNLOAD_LINK_TTL_SECONDS,
    clientIpSecret: v.CLIENT_IP_SECRET,
    rateLimit: {
      perMinute: v.RATE_LIMIT_PER_MINUTE,
      authPerMinute: v.AUTH_RATE_LIMIT_PER_MINUTE,
      wsConnectsPerMinute: v.WS_CONNECTS_PER_MINUTE,
      wsMessagesPer10s: v.WS_MESSAGES_PER_10S,
      wsJoinsPer10s: v.WS_JOINS_PER_10S,
      wsMaxConnectionsPerIp: v.WS_MAX_CONNECTIONS_PER_IP,
    },
  };
};

export const env = load();
