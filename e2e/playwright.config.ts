import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running stack (docker compose up). Everything goes through the
 * public address, as a visitor's browser would. Run them in the official Playwright image so
 * Chromium, Firefox and WebKit (the Safari engine) are all available.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './src/support/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
