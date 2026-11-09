import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

import { authFile, type Role } from './env';

/** Messages that mean the page and the server disagreed about the markup, or the app crashed. */
const PROBLEM = /hydrat|did not match|Minified React error|Text content does not match|Warning: /i;

const watch = (page: Page, issues: string[]) => {
  page.on('pageerror', (error) => issues.push(`uncaught error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && PROBLEM.test(message.text()))
      issues.push(`console: ${message.text()}`);
  });
};

export type Session = { context: BrowserContext; page: Page };

/**
 * `as(role)` opens a browser window already signed in as a demo user. Every window is watched:
 * a hydration error or an uncaught exception fails the test, in all three browsers.
 */
export const test = base.extend<{
  issues: string[];
  as: (role: Role) => Promise<Session>;
  anonymous: () => Promise<Session>;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their (here: no) dependencies
  issues: async ({}, use) => {
    const issues: string[] = [];
    await use(issues);
    expect(issues, 'hydration errors or uncaught exceptions in the browser').toEqual([]);
  },
  as: async ({ browser, issues }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (role) => {
      const context = await browser.newContext({ storageState: authFile(role) });
      contexts.push(context);
      context.on('page', (page) => watch(page, issues));
      const page = await context.newPage();
      return { context, page };
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
  anonymous: async ({ browser, issues }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      contexts.push(context);
      context.on('page', (page) => watch(page, issues));
      return { context, page: await context.newPage() };
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };
