import { defineConfig } from 'vitest/config';

// One run for the whole monorepo: every package with a vitest config (or tests) is a project.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    passWithNoTests: true,
    reporters: ['agent'],
  },
});
