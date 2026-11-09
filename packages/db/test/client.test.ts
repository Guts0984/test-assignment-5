import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDatabase, type TestDatabase } from './support/postgres';

describe('createDatabase', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startTestDatabase();
  });

  afterAll(async () => {
    await database.stop();
  });

  it('survives every connection being killed server-side, without crashing', async () => {
    const errors: Error[] = [];
    const handle = database.connect({ onError: (error) => errors.push(error) });

    await handle.pool.query('select 1'); // open a pooled connection
    await database.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where application_name = 'kanban' and pid <> pg_backend_pid() and datname = current_database()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The broken connection is discarded and a new one is opened transparently.
    const result = await handle.pool.query<{ ok: number }>('select 1 as ok');
    expect(result.rows[0]?.ok).toBe(1);
  });

  it('enforces the statement timeout', async () => {
    const handle = database.connect({ statementTimeoutMs: 200 });
    await expect(handle.pool.query('select pg_sleep(3)')).rejects.toMatchObject({ code: '57014' });
  });

  it('fails fast instead of hanging when the database is unreachable', async () => {
    const { createDatabase } = await import('../src/client');
    const handle = createDatabase({
      url: 'postgres://user:pw@127.0.0.1:1/none',
      connectTimeoutMs: 500,
      onError: () => undefined,
    });
    const started = Date.now();
    await expect(handle.pool.query('select 1')).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    await handle.close();
  });
});
