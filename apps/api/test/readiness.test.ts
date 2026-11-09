import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { call, expectError, startApp, testConfig, type RunningApp } from './support/app';
import {
  startContainer,
  startOwnPostgres,
  startOwnRedis,
  stopContainer,
  type OwnPostgres,
  type OwnRedis,
} from './support/containers';

const apps: RunningApp[] = [];
const launch = async (config = testConfig()) => {
  const running = await startApp(config);
  apps.push(running);
  return running;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((running) => running.close()));
});

const until = async (probe: () => Promise<boolean>, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('/health and /ready', () => {
  it('report a healthy stack', async () => {
    const { url } = await launch();
    expect(await call(`${url}/health`)).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(await call(`${url}/ready`)).toMatchObject({
      status: 200,
      body: { status: 'ok', checks: { postgres: 'up', redis: 'up', s3: 'up' } },
    });
  });

  it.each([
    [
      'postgres',
      (c: ReturnType<typeof testConfig>) => ({ ...c, postgres: { ...c.postgres, port: 1 } }),
    ],
    ['redis', (c: ReturnType<typeof testConfig>) => ({ ...c, redis: { ...c.redis, port: 1 } })],
    [
      's3',
      (c: ReturnType<typeof testConfig>) => ({
        ...c,
        s3: { ...c.s3, endpoint: 'http://127.0.0.1:1' },
      }),
    ],
  ])(
    'name the broken dependency (%s), answer quickly, and keep /health green',
    async (name, break_) => {
      const { url } = await launch(break_(testConfig()));

      const started = Date.now();
      const ready = await call(`${url}/ready`);
      expect(Date.now() - started).toBeLessThan(4_000);

      const error = expectError(ready, 503, 'service_unavailable');
      const checks = error.details?.checks as Record<string, string>;
      expect(checks[name]).toBe('down');
      expect(
        Object.entries(checks)
          .filter(([key]) => key !== name)
          .every(([, v]) => v === 'up'),
      ).toBe(true);
      expect((await call(`${url}/health`)).status).toBe(200);
    },
  );

  it('is not rate limited, so orchestrators can always probe it', async () => {
    const { url } = await launch(testConfig({ rateLimit: { perMinute: 1, authPerMinute: 1 } }));
    for (let i = 0; i < 5; i += 1) expect((await call(`${url}/health`)).status).toBe(200);
  });
});

describe('PostgreSQL restarting under a running API', () => {
  let pg: OwnPostgres;

  beforeAll(async () => {
    pg = await startOwnPostgres();
  });

  afterAll(async () => {
    await pg.container.stop();
  });

  it('turns requests into 503s, keeps the process alive, and recovers by itself', async () => {
    const shared = testConfig();
    const { url } = await launch({
      ...shared,
      postgres: {
        host: pg.container.getHost(),
        port: pg.port,
        user: pg.container.getUsername(),
        password: pg.container.getPassword(),
        database: pg.container.getDatabase(),
      },
    });
    expect((await call(`${url}/t/db`)).status).toBe(200);

    await stopContainer(pg.container.getId());

    const down = await call(`${url}/t/db`);
    expectError(down, 503, 'service_unavailable');
    expectError(await call(`${url}/ready`), 503, 'service_unavailable');
    expect((await call(`${url}/health`)).status).toBe(200); // the process is still up

    await startContainer(pg.container.getId());
    await until(
      async () => (await call(`${url}/t/db`)).status === 200,
      30_000,
      'PostgreSQL to be usable again',
    );
    expect((await call(`${url}/ready`)).status).toBe(200);
  });
});

describe('Redis restarting under a running API', () => {
  let redis: OwnRedis;

  beforeAll(async () => {
    redis = await startOwnRedis();
  });

  afterAll(async () => {
    await redis.container.stop();
  });

  it('degrades, keeps serving requests, and reconnects by itself', async () => {
    const shared = testConfig();
    const { url } = await launch({
      ...shared,
      redis: { host: redis.container.getHost(), port: redis.port, password: redis.password },
    });
    expect((await call(`${url}/t/redis`)).status).toBe(200);

    await stopContainer(redis.container.getId());

    expectError(await call(`${url}/t/redis`), 503, 'service_unavailable');
    const ready = expectError(await call(`${url}/ready`), 503, 'service_unavailable');
    expect((ready.details?.checks as Record<string, string>).redis).toBe('down');
    // The rate limiter fails open: requests that do not need Redis keep working.
    expect((await call(`${url}/t/db`)).status).toBe(200);
    expect((await call(`${url}/health`)).status).toBe(200);

    await startContainer(redis.container.getId());
    await until(
      async () => (await call(`${url}/t/redis`)).status === 200,
      30_000,
      'Redis to be usable again',
    );
    expect((await call(`${url}/ready`)).status).toBe(200);
  });
});
