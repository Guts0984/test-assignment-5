import { createDatabase } from '../client';
import { env } from '../env';
import { runMigrations } from '../migrate';
import { seedDatabase } from '../seed';

/**
 * One-shot database initialisation, run by the `init` service of docker-compose: apply
 * migrations, then create the demo data. Both steps are idempotent, so running it again
 * (container restarts, repeated `docker compose up`) changes nothing.
 */
// No statement timeout: a migration may legitimately take long.
const { db, pool, close } = createDatabase({
  url: env.url,
  statementTimeoutMs: 0,
  applicationName: 'kanban-init',
});

try {
  await runMigrations(pool);
  console.log('migrations applied');

  const result = await seedDatabase(db, env.seedPassword);
  console.log(
    result.seeded
      ? `seeded: ${result.users} users, ${result.workspaces} workspaces, ${result.boards} boards, ${result.columns} columns, ${result.cards} cards`
      : 'seed skipped: database already contains data',
  );
} catch (error) {
  console.error(`init failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await close();
}
