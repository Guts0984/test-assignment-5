import type { AddressInfo } from 'node:net';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorBodySchema, type ErrorBody, type ErrorCode } from '@kanban/shared';
import { expect, inject } from 'vitest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import type { AppConfig } from '../../src/config';
import { TestModule } from './test-module';

export const TEST_CLIENT_IP_SECRET = 'test-client-ip-secret-0123456789';

/** Config pointing at the shared containers; `overrides` swaps individual parts. */
type ConfigOverrides = Partial<Omit<AppConfig, 'rateLimit'>> & {
  rateLimit?: Partial<AppConfig['rateLimit']>;
};

export const testConfig = (overrides: ConfigOverrides = {}): AppConfig => {
  const infra = inject('infra');
  return {
    port: 0,
    appOrigin: 'http://localhost:8080',
    session: { cookieSecure: false, ttlSeconds: 3600 },
    inviteTtlSeconds: 3600,
    postgres: { ...infra.postgres },
    redis: { ...infra.redis },
    s3: {
      endpoint: infra.s3.endpoint,
      publicUrl: infra.s3.endpoint,
      bucket: infra.s3.bucket,
      region: 'us-east-1',
      accessKey: infra.s3.accessKey,
      secretKey: infra.s3.secretKey,
    },
    downloadLinkTtlSeconds: 300,
    clientIpSecret: TEST_CLIENT_IP_SECRET,
    ...overrides,
    // generous by default; a test that is about limits lowers exactly the ones it needs
    rateLimit: {
      perMinute: 10_000,
      authPerMinute: 10_000,
      wsConnectsPerMinute: 10_000,
      wsMessagesPer10s: 100_000,
      wsMaxConnectionsPerIp: 10_000,
      ...overrides.rateLimit,
    },
  };
};

export type RunningApp = {
  app: NestExpressApplication;
  url: string;
  close: () => Promise<void>;
};

/** Starts the real application (same setup as main.ts) on a random port, plus the test routes. */
export const startApp = async (config: AppConfig): Promise<RunningApp> => {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, [TestModule]),
    { bodyParser: false, logger: false },
  );
  configureApp(app, config);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
};

/** Fetch that never follows redirects and returns parsed JSON when there is some. */
export const call = async (
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; headers: Headers; body: unknown }> => {
  const { json, ...rest } = init;
  const response = await fetch(url, {
    redirect: 'manual',
    ...rest,
    ...(json !== undefined
      ? {
          body: JSON.stringify(json),
          headers: { 'content-type': 'application/json', ...rest.headers },
        }
      : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, headers: response.headers, body };
};

/**
 * Asserts the response is an error in the one documented shape (parsed with the shared schema,
 * so the contract itself is what is checked) and returns it.
 */
export const expectError = (
  response: { status: number; body: unknown },
  status: number,
  code: ErrorCode,
): ErrorBody['error'] => {
  const parsed = errorBodySchema.safeParse(response.body);
  expect(parsed.success, `not the documented error shape: ${JSON.stringify(response.body)}`).toBe(
    true,
  );
  expect(response.status).toBe(status);
  const error = (parsed.data as ErrorBody).error;
  expect(error.code).toBe(code);
  return error;
};
