import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests start real PostgreSQL containers, which can take a while on a cold machine.
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
