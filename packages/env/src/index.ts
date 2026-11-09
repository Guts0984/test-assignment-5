import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Reads the project's `.env` file. It is the only place configuration is read from:
 * neither the shell environment nor `.env.example` is ever consulted. Every app validates
 * the returned values against its own schema in its own `env.ts`.
 */

/** Walks up from `startDir` and returns the nearest `.env` file (never `.env.example`). */
export const findEnvFile = (startDir: string): string | undefined => {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

/** Parses the nearest `.env`. Throws a readable error if there is none. */
export const readDotEnv = (startDir: string = process.cwd()): Record<string, string> => {
  const file = findEnvFile(startDir);
  if (!file) throw new Error('No .env file found. Create it with: cp .env.example .env');
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
};

/**
 * Turns a failed Zod parse into a message that names the offending variables and never
 * prints their values (they may be secrets).
 */
export const describeEnvProblems = (
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string =>
  issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ');
