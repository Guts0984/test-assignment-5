import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { z } from 'zod';

/**
 * The single gate between the `.env` file and the rest of the code: raw text goes in, a
 * validated, typed object comes out. Nothing else reads configuration.
 *
 * - The only source is the nearest `.env` file. Neither the shell environment nor
 *   `.env.example` is consulted.
 * - Secrets and values that identify a deployment have NO defaults: if one is missing or
 *   invalid the process stops at startup with a readable message (names only, never values).
 * - Defaults exist only for public, non-sensitive values (host and port).
 *
 * Evaluated on import, so only entry points (CLI scripts, apps) import this module; library
 * code receives explicit options.
 */
const schema = z.object({
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  // Password given to every demo user created by the seed. Required: no default.
  SEED_PASSWORD: z.string().min(8),
});

/** Walks up from `startDir` and returns the nearest `.env` file (never `.env.example`). */
const findEnvFile = (startDir: string): string | undefined => {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const loadEnv = () => {
  const file = findEnvFile(process.cwd());
  if (!file) throw new Error('No .env file found. Create it with: cp .env.example .env');

  const result = schema.safeParse(parseEnv(readFileSync(file, 'utf8')));
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid .env: ${problems}`);
  }

  const values = result.data;
  const credentials = `${encodeURIComponent(values.POSTGRES_USER)}:${encodeURIComponent(values.POSTGRES_PASSWORD)}`;
  return {
    user: values.POSTGRES_USER,
    password: values.POSTGRES_PASSWORD,
    database: values.POSTGRES_DB,
    host: values.POSTGRES_HOST,
    port: values.POSTGRES_PORT,
    seedPassword: values.SEED_PASSWORD,
    /** Connection string built from the parts above, with credentials URL-encoded. */
    url: `postgres://${credentials}@${values.POSTGRES_HOST}:${values.POSTGRES_PORT}/${encodeURIComponent(values.POSTGRES_DB)}`,
  };
};

export const env = loadEnv();
export type Env = typeof env;
