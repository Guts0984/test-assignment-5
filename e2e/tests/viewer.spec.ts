import { addCard, apiAs, createBoard, json, workspaceId } from '../src/support/api';
import { openBoard } from '../src/support/board';
import { expect, test } from '../src/support/test';

test('a viewer can read everything and change nothing, in the screens and in the API', async ({
  as,
}) => {
  const alice = await apiAs('alice');
  const board = await createBoard(alice, 'viewer');
  const card = await addCard(alice, board.id, board.columns[0]!.id, 'Read only');
  const { page, context } = await as('carol'); // a viewer in Acme Product

  await openBoard(page, board.id);
  await expect(page.getByText('viewer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read only' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Move card/ })).toHaveCount(0); // nothing can be picked up
  await expect(page.getByLabel(/^New card in/)).toHaveCount(0); // no way to add cards

  await page.getByRole('link', { name: 'Read only' }).click();
  await expect(page.getByLabel('Title')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Description')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete card' })).toHaveCount(0);
  await expect(page.getByLabel('Add a comment')).toHaveCount(0);
  await expect(page.getByLabel('Attach an image or PDF (up to 10 MB)')).toHaveCount(0);

  // Even if the screen were bypassed, the server refuses every change from this session.
  const api = context.request;
  const refused = [
    await api.patch(`/api/cards/${card.id}`, { data: { version: 1, title: 'hacked' } }),
    await api.post(`/api/cards/${card.id}/move`, { data: { columnId: board.columns[1]!.id } }),
    await api.post(`/api/boards/${board.id}/cards`, {
      data: { columnId: board.columns[0]!.id, title: 'hacked' },
    }),
    await api.post(`/api/cards/${card.id}/comments`, { data: { body: 'hacked' } }),
    await api.delete(`/api/cards/${card.id}`),
    await api.post(`/api/workspaces/${await workspaceId(alice)}/boards`, {
      data: { name: 'hacked' },
    }),
  ];
  expect(refused.map((r) => r.status())).toEqual([403, 403, 403, 403, 403, 403]);
  const after = await json<{ cards: { title: string }[] }>(
    await alice.get(`/api/boards/${board.id}`),
  );
  expect(after.cards.map((c) => c.title)).toEqual(['Read only']); // nothing changed
});

test('a viewer sees no New board button, and a member of two workspaces only gets it where they can edit', async ({
  as,
}) => {
  const carol = await as('carol');
  await carol.page.goto('/');
  await expect(carol.page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  await expect(carol.page.getByRole('button', { name: /New board/ })).toHaveCount(0);

  const bob = await as('bob'); // editor in Acme, viewer in Beta Studio
  await bob.page.goto('/');
  await bob.page.getByRole('button', { name: /New board/ }).click();
  const options = await bob.page.getByLabel('Workspace', { exact: true }).count();
  expect(options).toBe(0); // only one workspace qualifies, so there is nothing to choose
  await expect(bob.page.locator('strong', { hasText: 'Acme Product' })).toBeVisible();
});

test('a new board can be created from the home page and opens at once', async ({ as }) => {
  const { page } = await as('alice');
  await page.goto('/');
  await page.getByRole('button', { name: /New board/ }).click();
  if ((await page.getByLabel('Workspace', { exact: true }).count()) > 0)
    await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Acme Product' }); // only shown with several choices
  const name = `E2E board ${Date.now().toString(36)}`;
  await page.getByLabel('Board name').fill(name);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  for (const column of ['To do', 'In progress', 'Done'])
    await expect(page.getByRole('heading', { name: new RegExp(`^${column}`) })).toBeVisible();
});
