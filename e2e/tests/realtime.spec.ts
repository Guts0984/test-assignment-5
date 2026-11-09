import { addCard, apiAs, createBoard } from '../src/support/api';
import { openBoard, titlesIn } from '../src/support/board';
import { expect, test } from '../src/support/test';

test('a card added by one person appears for the others at once, without reloading', async ({
  as,
}) => {
  const board = await createBoard(await apiAs('alice'), 'live');
  const [alice, bob, carol] = [await as('alice'), await as('bob'), await as('carol')]; // carol is a viewer
  await Promise.all([
    openBoard(alice.page, board.id),
    openBoard(bob.page, board.id),
    openBoard(carol.page, board.id),
  ]);

  await alice.page.getByLabel('New card in To do').fill('Written by Alice');
  await alice.page.getByRole('button', { name: 'Add' }).first().click();

  for (const watcher of [bob, carol]) {
    await expect.poll(() => titlesIn(watcher.page, 'To do')).toEqual(['Written by Alice']);
  }
});

test('everyone on the board sees who else is there, and a closed tab disappears within 10 seconds', async ({
  as,
}) => {
  const board = await createBoard(await apiAs('alice'), 'presence');
  const [alice, bob] = [await as('alice'), await as('bob')];
  await openBoard(alice.page, board.id);
  await openBoard(bob.page, board.id);

  const people = alice.page.getByRole('list', { name: 'People on this board' });
  await expect(people).toContainText('Bob Editor');
  await expect(bob.page.getByRole('list', { name: 'People on this board' })).toContainText(
    'Alice Owner',
  );

  await bob.context.close(); // the tab is closed without any goodbye from the page
  await expect(people).not.toContainText('Bob Editor', { timeout: 10_000 });
  await expect(people).toContainText('Alice Owner');
});

test('who is editing a card is shown on the board', async ({ as }) => {
  const api = await apiAs('alice');
  const board = await createBoard(api, 'editing');
  const card = await addCard(api, board.id, board.columns[0]!.id, 'Being edited');
  const [alice, bob] = [await as('alice'), await as('bob')];
  await openBoard(alice.page, board.id);
  await bob.page.goto(`/boards/${board.id}/cards/${card.id}`);
  await expect(alice.page.getByText('Bob Editor is editing')).toBeVisible();
  await bob.page.goto('/'); // leaving the card ends it
  await expect(alice.page.getByText('Bob Editor is editing')).toBeHidden();
});
