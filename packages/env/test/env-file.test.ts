import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeEnvProblems, findEnvFile, readDotEnv } from '../src';

const dirs: string[] = [];
const project = (files: { env?: string; example?: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'kanban-envfile-'));
  dirs.push(root);
  const nested = join(root, 'apps', 'api');
  mkdirSync(nested, { recursive: true });
  if (files.env !== undefined) writeFileSync(join(root, '.env'), files.env);
  if (files.example !== undefined) writeFileSync(join(root, '.env.example'), files.example);
  return nested;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readDotEnv', () => {
  it('reads the nearest .env above the start directory, including quoted values', () => {
    const nested = project({ env: 'A=1\nB="two words"\nC=\'p@ss:/w?rd#1\'\n' });
    expect(findEnvFile(nested)).toMatch(/\.env$/);
    expect(readDotEnv(nested)).toEqual({ A: '1', B: 'two words', C: 'p@ss:/w?rd#1' });
  });

  it('never falls back to .env.example', () => {
    const nested = project({ example: 'A=from_example\n' });
    expect(findEnvFile(nested)).toBeUndefined();
    expect(() => readDotEnv(nested)).toThrow('cp .env.example .env');
  });

  it('ignores the shell environment completely', () => {
    const nested = project({ env: 'A=from_file\n' });
    vi.stubEnv('A', 'from_shell');
    vi.stubEnv('ONLY_IN_SHELL', 'x');
    const values = readDotEnv(nested);
    expect(values.A).toBe('from_file');
    expect(values.ONLY_IN_SHELL).toBeUndefined();
  });
});

describe('describeEnvProblems', () => {
  it('names the variables and never repeats their values', () => {
    const message = describeEnvProblems([
      { path: ['REDIS_PASSWORD'], message: 'Invalid input' },
      { path: ['PORT'], message: 'Too big' },
    ]);
    expect(message).toBe('REDIS_PASSWORD: Invalid input; PORT: Too big');
  });
});
