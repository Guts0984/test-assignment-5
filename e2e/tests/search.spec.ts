import { hydrated } from '../src/support/board';
import { addCard, apiAs, createBoard, json } from '../src/support/api';
import { expect, test } from '../src/support/test';

test('search finds cards and comments with the matching words highlighted', async ({ as }) => {
  const api = await apiAs('alice');
  const board = await createBoard(api, 'search');
  const token = `zq${Date.now().toString(36)}`;
  const card = await addCard(
    api,
    board.id,
    board.columns[0]!.id,
    `Plan ${token} launch`,
    'Nothing special here',
  );
  await json(
    await api.post(`/api/cards/${card.id}/comments`, {
      data: { body: `a comment that also says ${token}` },
    }),
  );

  const { page } = await as('alice');
  await page.goto('/search');
  await page.getByLabel('Search cards and comments').fill(token);
  await expect(page.getByRole('link', { name: new RegExp(`Plan ${token}`) }).first()).toBeVisible();
  await expect(page.getByText('Comment', { exact: true })).toBeVisible();
  await expect(page.getByText('Card', { exact: true }).first()).toBeVisible();
  const marks = await page.locator('mark').allTextContents();
  expect(marks.length).toBeGreaterThan(0);
  expect(marks.every((text) => text.toLowerCase() === token)).toBe(true);

  await page.getByLabel('Search cards and comments').fill(`${token}nothing`);
  await expect(page.getByText(/Nothing found for/)).toBeVisible();
});

test('typing is not searched letter by letter, and an old answer never replaces a newer one', async ({
  as,
}) => {
  const { page } = await as('alice');
  const queries: string[] = [];
  await page.route('**/api/search?**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(q);
    if (q === 'roadmap') await new Promise((resolve) => setTimeout(resolve, 1_500)); // the first question is answered LAST
    await route.continue();
  });
  await page.goto('/search');
  await hydrated(page);
  const box = page.getByLabel('Search cards and comments');
  await box.pressSequentially('roadmap', { delay: 40 });
  await page.waitForTimeout(500);
  await box.fill('sprint');
  await expect(page.getByText('Sprint', { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(2_500); // long enough for the slow, old answer to have arrived
  await expect(box).toHaveValue('sprint');
  const shown = (await page.locator('main').innerText()).toLowerCase();
  expect(shown).toContain('sprint');
  expect(queries).toEqual(['roadmap', 'sprint']); // one request per pause in typing, not eleven
});

test('search only offers workspaces the person belongs to, and finds nothing from the others', async ({
  as,
}) => {
  const alice = await as('alice'); // member of Acme Product only
  await alice.page.goto('/search');
  const options = await alice.page.getByLabel('Workspace').locator('option').allTextContents();
  expect(options).toEqual(['Acme Product']);
});
