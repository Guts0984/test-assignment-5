import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

import * as schema from './schema';

/** Arbitrary constant shared by every process that may run migrations. */
const MIGRATION_LOCK_KEY = 727_001;

export const defaultMigrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations. A session-level advisory lock serialises concurrent runners
 * (e.g. several containers starting together): the second one waits, then finds nothing to
 * do. Running it again is always a no-op.
 *
 * Use a pool without a statement timeout for this call (`statementTimeoutMs: 0`).
 */
export const runMigrations = async (
  pool: pg.Pool,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
};
