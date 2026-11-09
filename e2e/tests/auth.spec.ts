import { ACCOUNTS, PASSWORD } from '../src/support/env';
import { expect, test } from '../src/support/test';

test('a visitor without a session is sent to sign in and comes back to the page afterwards', async ({
  anonymous,
  issues,
}) => {
  void issues;
  const { page } = await anonymous();
  await page.goto('/search');
  await expect(page).toHaveURL(/\/login\?next=%2Fsearch/);
  await page.getByLabel('Email').fill(ACCOUNTS.alice);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
});

test('a wrong password is explained and the visitor stays on the form', async ({ anonymous }) => {
  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByLabel('Email').fill(ACCOUNTS.alice);
  await page.getByLabel('Password').fill('definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /\w/ })).toHaveText(
    'The email or password is not correct.',
  );
  await expect(page).toHaveURL(/\/login/);
});

test('empty fields are explained next to each field, and tied to it for screen readers', async ({
  anonymous,
}) => {
  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  const described = await email.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${described}"]`)).toBeVisible();
});

test('signing out ends the session on the server', async ({ anonymous }) => {
  const { page } = await anonymous();
  await page.goto('/login'); // its own sign-in: signing out must not end the shared demo sessions
  await page.getByLabel('Email').fill(ACCOUNTS.alice);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('the "next" address cannot send a visitor to another site', async ({ anonymous }) => {
  const { page } = await anonymous();
  await page.goto('/login?next=https://evil.example/phish');
  await page.getByLabel('Email').fill(ACCOUNTS.alice);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  expect(new URL(page.url()).hostname).not.toContain('evil');
});

test('the page you may not see looks the same as one that does not exist', async ({ as }) => {
  const { page } = await as('carol');
  await page.goto('/boards/123e4567-e89b-42d3-a456-426614174999');
  await expect(page.getByText(/does not exist, or you do not have access/i)).toBeVisible();
});
