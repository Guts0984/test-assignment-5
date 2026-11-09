import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, inject } from 'vitest';

import { createShutdown } from '../src/shutdown';
import { freePort } from './support/containers';
import { call, startApp, testConfig, type RunningApp } from './support/app';

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

describe('graceful shutdown (in process)', () => {
  let api: RunningApp | undefined;

  afterEach(async () => {
    await api?.close().catch(() => undefined);
    api = undefined;
  });

  it('lets a running request finish, refuses new ones, and exits with 0', async () => {
    api = await startApp(testConfig());
    const exits: number[] = [];
    const shutdown = createShutdown(api.app, {
      timeoutMs: 10_000,
      exit: (c) => exits.push(c),
      log: () => undefined,
    });

    const inFlight = call(`${api.url}/t/slow?ms=1000`);
    await sleep(200);
    const finished = shutdown('SIGTERM');

    const response = await inFlight;
    expect(response).toMatchObject({ status: 200, body: { done: true } });
    expect(exits).toEqual([]); // not exited while the request was still running
    await finished;
    expect(exits).toEqual([0]);

    await expect(fetch(`${api.url}/health`)).rejects.toThrow(); // nothing listens any more
    await shutdown('SIGTERM'); // a second signal changes nothing
    expect(exits).toEqual([0]);
  });

  it('gives up with a failure code if draining takes longer than the limit', async () => {
    api = await startApp(testConfig());
    const exits: number[] = [];
    const shutdown = createShutdown(api.app, {
      timeoutMs: 300,
      exit: (c) => exits.push(c),
      log: () => undefined,
    });

    const inFlight = call(`${api.url}/t/slow?ms=1500`);
    await sleep(100);
    void shutdown('SIGTERM');
    await sleep(600);
    expect(exits[0]).toBe(1);
    await inFlight.catch(() => undefined);
  });
});

describe('the real process', () => {
  const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
  const main = resolve(import.meta.dirname, '../src/main.ts');
  const tsconfig = resolve(import.meta.dirname, '../tsconfig.json');
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Starts src/main.ts exactly as `node` would, with configuration only from a .env file. */
  const startProcess = (env: Record<string, string | number>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'kanban-api-'));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, '.env'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    const child = spawn(tsx, ['--tsconfig', tsconfig, main], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    return { child, exited, output: () => ({ stdout, stderr }) };
  };

  const validEnv = async () => {
    const { postgres, redis, s3 } = inject('infra');
    return {
      PORT: await freePort(),
      POSTGRES_USER: postgres.user,
      POSTGRES_PASSWORD: postgres.password,
      POSTGRES_DB: postgres.database,
      POSTGRES_HOST: postgres.host,
      POSTGRES_PORT: postgres.port,
      REDIS_HOST: redis.host,
      REDIS_PORT: redis.port,
      REDIS_PASSWORD: redis.password,
      MINIO_ROOT_USER: s3.accessKey,
      MINIO_ROOT_PASSWORD: s3.secretKey,
      S3_ENDPOINT: s3.endpoint,
      S3_BUCKET: s3.bucket,
    };
  };

  it('starts from a .env file alone, is ready, and exits with code 0 on SIGTERM', async () => {
    const env = await validEnv();
    const running = startProcess(env);
    const url = `http://127.0.0.1:${env.PORT}`;

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      ready = await fetch(`${url}/ready`).then(
        (r) => r.status === 200,
        () => false,
      );
      if (!ready) await sleep(300);
    }
    expect(ready, running.output().stderr).toBe(true);

    running.child.kill('SIGTERM');
    const result = await Promise.race([
      running.exited,
      sleep(10_000).then(() => 'timeout' as const),
    ]);
    expect(result, 'process did not exit after SIGTERM').not.toBe('timeout');
    expect(result).toEqual({ code: 0, signal: null });
    expect(running.output().stdout).toContain('shutdown complete');
  });

  it('refuses to start without a secret, naming it but not printing other values', async () => {
    const { REDIS_PASSWORD: _omitted, ...rest } = await validEnv();
    // Distinctive secrets, so "not printed" cannot be confused with a word in a file path.
    const incomplete = {
      ...rest,
      POSTGRES_PASSWORD: `pg-secret-${randomUUID()}`,
      MINIO_ROOT_PASSWORD: `minio-secret-${randomUUID()}`,
    };
    const running = startProcess(incomplete);
    const result = await Promise.race([
      running.exited,
      sleep(20_000).then(() => 'timeout' as const),
    ]);
    expect(result).not.toBe('timeout');
    expect(result).not.toMatchObject({ code: 0 });
    const { stderr } = running.output();
    expect(stderr).toContain('REDIS_PASSWORD');
    expect(stderr).not.toContain(incomplete.MINIO_ROOT_PASSWORD);
    expect(stderr).not.toContain(incomplete.POSTGRES_PASSWORD);
  });
});
