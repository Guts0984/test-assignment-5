import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real PostgreSQL, Redis, MinIO and Mailpit containers, started once for the whole run.
    globalSetup: ['./test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
