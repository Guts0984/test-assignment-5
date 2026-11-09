import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { createDatabase, type DatabaseHandle, type DatabaseOptions } from '../../src/client';
import { runMigrations } from '../../src/migrate';

export type TestDatabase = DatabaseHandle & {
  url: string;
  /** Opens an extra independent pool (e.g. to simulate several API instances). */
  connect: (options?: Partial<DatabaseOptions>) => DatabaseHandle;
  stop: () => Promise<void>;
};

/** Starts a throwaway PostgreSQL 16, applies all migrations and returns a connected handle. */
export const startTestDatabase = async (): Promise<TestDatabase> => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();

  const migrator = createDatabase({ url, statementTimeoutMs: 0 });
  await runMigrations(migrator.pool);
  await migrator.close();

  const main = createDatabase({ url, maxConnections: 20, connectTimeoutMs: 30_000 });
  const extra: DatabaseHandle[] = [];

  return {
    ...main,
    url,
    connect: (options) => {
      const handle = createDatabase({ url, connectTimeoutMs: 30_000, ...options });
      extra.push(handle);
      return handle;
    },
    stop: async () => {
      await Promise.all(extra.map((handle) => handle.close()));
      await main.close();
      await container.stop();
    },
  };
};
