import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/client';
import { runMigrations } from '../src/migrate';

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  });

  afterAll(async () => {
    await container.stop();
  });

  it('is idempotent and safe when several runners start at once', async () => {
    const handles = Array.from({ length: 4 }, () =>
      createDatabase({ url: container.getConnectionUri(), statementTimeoutMs: 0 }),
    );
    try {
      await Promise.all(handles.map((handle) => runMigrations(handle.pool)));
      await runMigrations(handles[0]!.pool); // run again: must be a no-op

      const [tables, applied] = await Promise.all([
        handles[0]!.pool.query<{ count: string }>(
          `select count(*) from information_schema.tables where table_schema = 'public'`,
        ),
        handles[0]!.pool.query<{ count: string }>(
          `select count(*) from drizzle.__drizzle_migrations`,
        ),
      ]);
      expect(Number(tables.rows[0]?.count)).toBe(12);
      expect(Number(applied.rows[0]?.count)).toBe(1);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
  });
});
