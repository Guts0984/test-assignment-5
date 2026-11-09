import {
  apiAs,
  createBoard,
  json,
  registerUser,
  registerViewerInAcme,
  uniqueName,
} from '../src/support/api';
import { openBoard } from '../src/support/board';
import { expect, test } from '../src/support/test';

test('a brand-new user creates a workspace and a board, renames the board and deletes it', async ({
  anonymous,
}) => {
  const user = await registerUser('founder');
  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  await expect(page.getByRole('button', { name: /New board/ })).toHaveCount(0); // nowhere to put one yet

  const workspace = uniqueName('Founders');
  await page.getByRole('button', { name: /New workspace/ }).click();
  await page.getByLabel('Workspace name').fill(workspace);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const section = page.getByRole('region', { name: new RegExp(workspace) });
  await expect(section).toBeVisible();
  await expect(section.getByText('owner', { exact: true })).toBeVisible();

  const boardName = uniqueName('Plan');
  await page.getByRole('button', { name: /New board/ }).click();
  await page.getByLabel('Board name').fill(boardName);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page).toHaveURL(/\/boards\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: boardName })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();

  const renamed = uniqueName('Better plan');
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Board name').fill(renamed);
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('strong', { hasText: renamed })).toBeVisible();
  await page.getByRole('button', { name: 'Delete board' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: renamed })).toHaveCount(0);
});

test('someone who is only a viewer in another workspace can still start and own their own', async ({
  anonymous,
}) => {
  const user = await registerViewerInAcme('viewer-founder');
  const { page } = await anonymous();
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible();
  const acme = page.getByRole('region', { name: /Acme Product/ });
  await expect(acme.getByText('viewer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /New board/ })).toHaveCount(0); // nowhere to edit yet

  const workspace = uniqueName('Mine');
  await page.getByRole('button', { name: /New workspace/ }).click();
  await page.getByLabel('Workspace name').fill(workspace);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const mine = page.getByRole('region', { name: new RegExp(workspace) });
  await expect(mine.getByText('owner', { exact: true })).toBeVisible();
  await expect(acme.getByText('viewer', { exact: true })).toBeVisible(); // unchanged there

  // "New board" now offers only the workspace they own
  await page.getByRole('button', { name: /New board/ }).click();
  await expect(page.getByLabel('Workspace', { exact: true })).toHaveCount(0);
  await expect(page.locator('strong', { hasText: workspace })).toBeVisible();
});

test('a rename shows up live for the other viewer, and a delete sends them home', async ({
  as,
}) => {
  const alice = await apiAs('alice');
  const board = await createBoard(alice, 'live-manage');
  const bob = await as('bob'); // editor, but not the creator
  await openBoard(bob.page, board.id);
  await expect(bob.page.getByRole('button', { name: 'Rename' })).toHaveCount(0); // not his board
  await expect(bob.page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

  const renamed = uniqueName('Renamed live');
  await json(await alice.patch(`/api/boards/${board.id}`, { data: { name: renamed } }));
  await expect(bob.page.getByRole('heading', { name: renamed })).toBeVisible();

  await alice.delete(`/api/boards/${board.id}`);
  await expect(bob.page).toHaveURL(/\/$/);
  await expect(bob.page.getByText('This board was deleted.')).toBeVisible();
  const gone = await bob.context.request.get(`/api/boards/${board.id}`);
  expect(gone.status()).toBe(404);
});

test('the creator can manage their own board; the owner can manage anybody’s; a viewer neither', async ({
  as,
}) => {
  const bobApi = await apiAs('bob');
  const mine = await createBoard(bobApi, 'bobs');
  const bob = await as('bob');
  await openBoard(bob.page, mine.id);
  await expect(bob.page.getByRole('button', { name: 'Rename' })).toBeVisible(); // his own board

  const alice = await as('alice');
  await openBoard(alice.page, mine.id);
  await expect(alice.page.getByRole('button', { name: 'Rename' })).toBeVisible(); // owner of the workspace

  const carol = await as('carol');
  await openBoard(carol.page, mine.id);
  await expect(carol.page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  const refused = await carol.context.request.delete(`/api/boards/${mine.id}`);
  expect(refused.status()).toBe(403);
});
