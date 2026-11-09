import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real PostgreSQL, Redis and MinIO containers are started once for the whole run.
    globalSetup: ['./test/support/global-setup.ts'],
    // The files share one PostgreSQL, Redis and MinIO and start full API instances; running them
    // one at a time keeps timing-sensitive tests (presence, flood, expiry) reliable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
