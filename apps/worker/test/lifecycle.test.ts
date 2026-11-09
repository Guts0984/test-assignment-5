import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, inject, it } from 'vitest';

import { createMailer } from '../src/mail/mailer';
import {
  harness,
  mailTo,
  queueInvite,
  sleep,
  uniqueEmail,
  waitFor,
  type Harness,
} from './support/harness';

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  await h?.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scheduling', () => {
  it('starting the worker again (a restart) does not duplicate the schedules', async () => {
    h = harness();
    await h.start();
    await h.start();
    await h.start();
    const schedulers = await h.deps.queues.maintenance.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort()).toEqual([
      'cleanup',
      'scan-mentions',
      'scan-outbox',
    ]);
  });
});

describe('stopping', () => {
  it('lets the job that is running finish before the worker closes, and loses nothing', async () => {
    const real = createMailer({
      host: inject('infra').smtp.host,
      port: inject('infra').smtp.port,
      from: 'Kanban <no-reply@kanban.local>',
    });
    let started = false;
    h = harness({}, async (mail) => {
      started = true;
      await sleep(1_500); // a slow send
      await real(mail);
    });
    const to = uniqueEmail('slow');
    await queueInvite(to);
    const worker = await h.start();
    await waitFor(() => started, 10_000, 'the send to begin');

    const stoppedAt = Date.now();
    await worker.stop(); // asked while the email is being sent
    expect(Date.now() - stoppedAt).toBeGreaterThan(500); // it waited for the job
    expect(await mailTo(to)).toHaveLength(1); // and the email was delivered
  });
});

describe('the real process', () => {
  const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
  const main = resolve(import.meta.dirname, '../src/main.ts');
  const tsconfig = resolve(import.meta.dirname, '../tsconfig.json');

  const freePort = () =>
    new Promise<number>((resolvePort) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolvePort(port));
      });
    });

  const validEnv = async () => {
    const { postgres, redis, s3, smtp } = inject('infra');
    return {
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
      SMTP_HOST: smtp.host,
      SMTP_PORT: smtp.port,
      WORKER_HEALTH_PORT: await freePort(),
      SCAN_INTERVAL_SECONDS: 1,
    };
  };

  const startProcess = (env: Record<string, string | number>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'kanban-worker-'));
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

  it('starts from a .env file alone, sends an email, and exits with code 0 on SIGTERM', async () => {
    const env = await validEnv();
    const to = uniqueEmail('process');
    await queueInvite(to);
    const running = startProcess(env);

    await waitFor(
      async () => (await mailTo(to)).length === 1,
      40_000,
      `the email (${running.output().stderr.slice(0, 300)})`,
    );
    const health = await fetch(`http://127.0.0.1:${env.WORKER_HEALTH_PORT}/health`);
    expect(health.status).toBe(200);

    running.child.kill('SIGTERM');
    const result = await Promise.race([
      running.exited,
      sleep(15_000).then(() => 'timeout' as const),
    ]);
    expect(result, 'did not exit after SIGTERM').not.toBe('timeout');
    expect(result).toEqual({ code: 0, signal: null });
    expect(running.output().stdout).toContain('shutdown complete');
  });

  it('refuses to start without a secret, naming it but not printing the other values', async () => {
    const { REDIS_PASSWORD: _omitted, ...rest } = await validEnv();
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
    expect(stderr).not.toContain(incomplete.POSTGRES_PASSWORD);
    expect(stderr).not.toContain(incomplete.MINIO_ROOT_PASSWORD);
  });
});
