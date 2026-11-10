import { apiAs, json, registerUser, workspaceId } from '../src/support/api';
import { waitForEmail } from '../src/support/mailpit';
import { expect, test } from '../src/support/test';

test('an invitation sent from the settings page arrives by email and the link brings the new person into the workspace', async ({
  as,
  anonymous,
}) => {
  const alice = await as('alice');
  const wsId = await workspaceId(await apiAs('alice'));
  const email = `invitee-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@example.com`;

  await alice.page.goto(`/workspaces/${wsId}/settings`);
  await alice.page.getByLabel('Email address').fill(email);
  await alice.page.getByLabel('Role', { exact: true }).selectOption('viewer');
  await alice.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(alice.page.getByText(`Invitation sent to ${email}.`)).toBeVisible();

  const mail = await waitForEmail(email); // read from Mailpit's API
  expect(mail.subject).toMatch(/invited you to Acme Product/);
  const link = mail.text.match(/https?:\/\/\S+\/invite\/[\w-]+/)?.[0];
  expect(link, 'the email contains the invitation link').toBeTruthy();

  const guest = await anonymous();
  await guest.page.goto(link!);
  await expect(guest.page.getByRole('heading', { name: 'Join Acme Product' })).toBeVisible();
  await guest.page.getByRole('link', { name: 'Create account' }).click();
  await guest.page.getByLabel('Name').fill('Invited Person');
  await guest.page.getByLabel('Email').fill(email);
  await guest.page.getByLabel('Handle').fill(`inv${Date.now().toString(36)}`.slice(0, 28));
  await guest.page.getByLabel('Password').fill('e2e-long-password-1');
  await guest.page.getByRole('button', { name: 'Create account' }).click();

  await expect(guest.page.getByRole('button', { name: 'Accept invitation' })).toBeVisible(); // back on the invitation, signed in
  await guest.page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Acme Product' })).toBeVisible();
  await expect(guest.page.getByRole('link', { name: 'Roadmap' })).toBeVisible();

  await guest.page.goto(link!); // the link works once
  await expect(
    guest.page.getByRole('heading', { name: 'This invitation is not valid' }),
  ).toBeVisible();
});

test('whoever registers the invited address gets nothing from the app: the emailed link is the only way in', async ({
  anonymous,
}) => {
  const api = await apiAs('alice');
  const person = await registerUser('inapp');
  await json(
    await api.post(`/api/workspaces/${await workspaceId(api)}/invites`, {
      data: { email: person.email, role: 'editor' },
    }),
  );

  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Signed in with the invited address, but without the link: no invitation is offered, no
  // workspace appears, and the old in-app endpoints are gone.
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invitations for you' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Acme Product/ })).toHaveCount(0);
  expect((await page.request.get('/api/me/invites')).status()).toBe(404);
});

test('an invitation cannot be used by a different account', async ({ anonymous }) => {
  const api = await apiAs('alice');
  const target = `target-${Date.now().toString(36)}@example.com`;
  await json(
    await api.post(`/api/workspaces/${await workspaceId(api)}/invites`, {
      data: { email: target, role: 'viewer' },
    }),
  );
  const link = (await waitForEmail(target)).text.match(/https?:\/\/\S+\/invite\/[\w-]+/)?.[0] ?? '';

  const other = await registerUser('other');
  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByLabel('Email').fill(other.email);
  await page.getByLabel('Password').fill(other.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible(); // signed in
  await page.goto(link);
  await expect(page.getByRole('alert').filter({ hasText: /\w/ })).toContainText(
    `This invitation is for ${target}`,
  );
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
});
