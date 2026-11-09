import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const validEnv =
  'POSTGRES_USER=kanban\nPOSTGRES_PASSWORD=s3cret\nPOSTGRES_DB=kanban\nSEED_PASSWORD=seed-secret-1\n';

const dirs: string[] = [];

/** Creates root/packages/db, optionally writes `.env` / `.env.example` in root, and makes
 * `process.cwd()` point at the nested folder, like running a script from a package. */
const project = (files: { env?: string; example?: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'kanban-env-'));
  dirs.push(root);
  const nested = join(root, 'packages', 'db');
  mkdirSync(nested, { recursive: true });
  if (files.env !== undefined) writeFileSync(join(root, '.env'), files.env);
  if (files.example !== undefined) writeFileSync(join(root, '.env.example'), files.example);
  vi.spyOn(process, 'cwd').mockReturnValue(nested);
};

/** Imports a fresh copy of the real module, which reads the file at import time. */
const loadEnv = async () => {
  vi.resetModules();
  return (await import('../src/env')).env;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('env.ts', () => {
  it('reads the nearest .env above the working directory', async () => {
    project({ env: `${validEnv}POSTGRES_DB="quoted db"\n` });
    const env = await loadEnv();
    expect(env.user).toBe('kanban');
    expect(env.database).toBe('quoted db');
  });

  it('applies defaults only to public values', async () => {
    project({ env: validEnv });
    const env = await loadEnv();
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(5432);
  });

  it.each(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'SEED_PASSWORD'])(
    'refuses to start without %s and does not invent a default',
    async (name) => {
      const without = validEnv
        .split('\n')
        .filter((line) => !line.startsWith(`${name}=`))
        .join('\n');
      project({ env: without });
      await expect(loadEnv()).rejects.toThrow(name);

      project({ env: `${without}${name}=\n` });
      await expect(loadEnv()).rejects.toThrow(name);
    },
  );

  it('rejects an invalid value without leaking secrets', async () => {
    project({ env: `${validEnv}POSTGRES_PORT=not-a-port\n` });
    const error = await loadEnv().then(
      () => undefined,
      (caught: unknown) => String(caught),
    );
    expect(error).toContain('POSTGRES_PORT');
    expect(error).not.toContain('s3cret');
    expect(error).not.toContain('seed-secret-1');
  });

  it('builds a connection string that survives special characters in the password', async () => {
    project({
      env: "POSTGRES_USER=u\nPOSTGRES_PASSWORD='p@ss:/w?rd#1'\nPOSTGRES_DB=d\nSEED_PASSWORD=seed-secret-1\n",
    });
    const url = new URL((await loadEnv()).url);
    expect(decodeURIComponent(url.password)).toBe('p@ss:/w?rd#1');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/d');
  });

  it('never falls back to .env.example', async () => {
    project({ example: validEnv });
    await expect(loadEnv()).rejects.toThrow('cp .env.example .env');
  });

  it('ignores the shell environment completely', async () => {
    project({ env: 'POSTGRES_USER=from_file\nPOSTGRES_DB=kanban\nSEED_PASSWORD=seed-secret-1\n' });
    vi.stubEnv('POSTGRES_PASSWORD', 'from_shell'); // would satisfy the schema if it were read
    await expect(loadEnv()).rejects.toThrow('POSTGRES_PASSWORD');

    project({ env: validEnv });
    vi.stubEnv('POSTGRES_USER', 'from_shell');
    expect((await loadEnv()).user).toBe('kanban');
  });
});
