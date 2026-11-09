import { describeEnvProblems, readDotEnv } from '@kanban/env';
import { z } from 'zod';

import { postgresUrl } from './client';

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

const loadEnv = () => {
  const result = schema.safeParse(readDotEnv());
  if (!result.success) throw new Error(`Invalid .env: ${describeEnvProblems(result.error.issues)}`);

  const values = result.data;
  const connection = {
    user: values.POSTGRES_USER,
    password: values.POSTGRES_PASSWORD,
    database: values.POSTGRES_DB,
    host: values.POSTGRES_HOST,
    port: values.POSTGRES_PORT,
  };
  return { ...connection, seedPassword: values.SEED_PASSWORD, url: postgresUrl(connection) };
};

export const env = loadEnv();
export type Env = typeof env;
