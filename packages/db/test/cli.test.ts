import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(packageDir, 'node_modules', '.bin', 'tsx');

let container: StartedPostgreSqlContainer;
const dirs: string[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
});

afterAll(async () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  await container.stop();
});

/** A folder holding only a `.env`, so the commands can read configuration from nowhere else. */
const workdir = (env: Record<string, string | number> | null): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-cli-'));
  dirs.push(dir);
  if (env) {
    writeFileSync(
      join(dir, '.env'),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
  }
  return dir;
};

const goodEnv = () => ({
  POSTGRES_USER: container.getUsername(),
  POSTGRES_PASSWORD: container.getPassword(),
  POSTGRES_DB: container.getDatabase(),
  POSTGRES_HOST: container.getHost(),
  POSTGRES_PORT: container.getPort(),
  SEED_PASSWORD: 'cli-seed-password',
});

/** Runs the init command the way the compose `init` service does, with a bare environment. */
const init = async (cwd: string) => {
  try {
    const { stdout, stderr } = await run(tsx, [join(packageDir, 'src', 'bin', 'init.ts')], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
};

const query = async <T extends pg.QueryResultRow>(
  text: string,
  database?: string,
): Promise<T[]> => {
  const uri = new URL(container.getConnectionUri());
  if (database) uri.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: uri.toString() });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
};

describe('db init command', () => {
  it('builds the whole database from nothing but a .env file, and can be re-run safely', async () => {
    const cwd = workdir(goodEnv());

    const first = await init(cwd);
    expect(first).toMatchObject({ code: 0 });
    expect(first.stdout).toContain('migrations applied');
    expect(first.stdout).toMatch(/seeded: 4 users, 2 workspaces, 3 boards, 15 columns, \d+ cards/);

    // Running it again (container restart, second `docker compose up`) changes nothing.
    const again = await init(cwd);
    expect(again).toMatchObject({ code: 0 });
    expect(again.stdout).toContain('skipped');

    const [counts] = await query<{ users: string; workspaces: string; cards: string }>(
      `select (select count(*) from users) as users,
              (select count(*) from workspaces) as workspaces,
              (select count(*) from cards) as cards`,
    );
    expect(counts).toMatchObject({ users: '4', workspaces: '2' });
    expect(Number(counts?.cards)).toBeGreaterThanOrEqual(1000);
  });

  it('exits non-zero with a clear message when there is no .env', async () => {
    const result = await init(workdir(null));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('cp .env.example .env');
  });

  it('stops before touching the database when a required value is missing', async () => {
    await query('create database untouched');
    const { SEED_PASSWORD: _omitted, ...withoutSeedPassword } = goodEnv();
    const result = await init(workdir({ ...withoutSeedPassword, POSTGRES_DB: 'untouched' }));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SEED_PASSWORD');
    const tables = await query<{ n: string }>(
      `select count(*) as n from information_schema.tables where table_schema = 'public'`,
      'untouched',
    );
    expect(tables[0]?.n).toBe('0');
  });

  it('exits non-zero, without leaking the password, when the database is unreachable', async () => {
    const result = await init(workdir({ ...goodEnv(), POSTGRES_PORT: 1 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('init failed');
    expect(result.stderr).not.toContain(container.getPassword());
  });
});
