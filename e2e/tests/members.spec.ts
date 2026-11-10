import { request } from '@playwright/test';

import { apiAs, createBoard, json, workspaceId } from '../src/support/api';
import { BASE_URL } from '../src/support/env';
import { openBoard } from '../src/support/board';
import { inviteTokenFor } from '../src/support/mailpit';
import { expect, test } from '../src/support/test';

test('removing a member cuts them off at once, even in a board they have open', async ({
  browser,
  as,
}) => {
  const owner = await apiAs('alice');
  const wsId = await workspaceId(owner);
  const board = await createBoard(owner, 'revoke');

  // A temporary member: registers, is invited, and accepts with the token from the email.
  const stranger = await request.newContext({ baseURL: BASE_URL });
  const email = `leaver-${Date.now().toString(36)}@example.com`;
  const me = await json<{ id: string }>(
    await stranger.post('/api/auth/register', {
      data: {
        email,
        handle: `leaver${Date.now().toString(36)}`.slice(0, 30),
        name: 'Temporary Member',
        password: 'e2e-long-password-1',
      },
    }),
  );
  await json(
    await owner.post(`/api/workspaces/${wsId}/invites`, { data: { email, role: 'editor' } }),
  );
  await json(await stranger.post(`/api/invites/${await inviteTokenFor(email)}/accept`));

  const context = await browser.newContext({ storageState: await stranger.storageState() });
  const member = await context.newPage();
  const alice = await as('alice');
  await openBoard(member, board.id);
  await openBoard(alice.page, board.id);
  await expect(alice.page.getByRole('list', { name: 'People on this board' })).toContainText(
    'Temporary Member',
  );

  expect((await owner.delete(`/api/workspaces/${wsId}/members/${me.id}`)).status()).toBe(204);

  await expect(member.getByText('You no longer have access to this board.')).toBeVisible({
    timeout: 8_000,
  });
  await expect(member).toHaveURL(/\/$/);
  await expect(alice.page.getByRole('list', { name: 'People on this board' })).not.toContainText(
    'Temporary Member',
    { timeout: 10_000 },
  );
  expect((await stranger.get(`/api/boards/${board.id}`)).status()).toBe(404); // the same session now sees nothing
  expect((await stranger.get(`/api/workspaces/${wsId}/members`)).status()).toBe(404);

  await context.close();
  await stranger.dispose();
});

test('an owner changes a role in the settings and removes a member, using the page', async ({
  as,
}) => {
  const owner = await apiAs('alice');
  const wsId = await workspaceId(owner);
  const name = `Settings Member ${Math.random().toString(36).slice(2, 8)}`; // unique: browsers run in parallel
  const email = `member-${Date.now().toString(36)}@example.com`;
  const person = await request.newContext({ baseURL: BASE_URL });
  const handle = `member${Date.now().toString(36)}`.slice(0, 30);
  await json(
    await person.post('/api/auth/register', {
      data: { email, handle, name, password: 'e2e-long-password-1' },
    }),
  );
  await json(
    await owner.post(`/api/workspaces/${wsId}/invites`, { data: { email, role: 'viewer' } }),
  );
  await json(await person.post(`/api/invites/${await inviteTokenFor(email)}/accept`));

  const { page } = await as('alice');
  await page.goto(`/workspaces/${wsId}/settings`);
  const row = page.getByRole('listitem').filter({ hasText: name });
  await row.getByLabel(`Role of ${name}`).selectOption('editor');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('Role updated.')).toBeVisible();
  expect(
    (await json<{ boards: unknown[]; role: string }[]>(await person.get('/api/workspaces'))).find(
      (w) => w.role === 'editor',
    ),
  ).toBeTruthy();

  await row.getByRole('button', { name: `Remove ${name}` }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
  await person.dispose();
});

test('only owners see the controls: an editor sees the member list but cannot change it', async ({
  as,
}) => {
  const wsId = await workspaceId(await apiAs('alice'));
  const { page } = await as('bob');
  await page.goto(`/workspaces/${wsId}/settings`);
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Invite someone' })).toHaveCount(0);
  await expect(page.getByText('Only owners can change roles or invite people.')).toBeVisible();
});
