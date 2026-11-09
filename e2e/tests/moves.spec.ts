import type { Page } from '@playwright/test';

import { addCard, apiAs, createBoard, json, type Column } from '../src/support/api';
import { dragWithKeyboard, openBoard, titlesIn } from '../src/support/board';
import { expect, test } from '../src/support/test';

const seed = async (titles: string[]) => {
  const api = await apiAs('alice');
  const board = await createBoard(api, 'moves');
  const ids: string[] = [];
  for (const title of titles)
    ids.push((await addCard(api, board.id, board.columns[0]!.id, title)).id);
  return { api, board, ids };
};

test('a card moves with the keyboard, within a column and into another, and stays there after a reload', async ({
  as,
}) => {
  const { board } = await seed(['Card A', 'Card B', 'Card C']);
  const { page } = await as('alice');
  await openBoard(page, board.id);

  await dragWithKeyboard(page, 'Card A', ['ArrowDown', 'ArrowDown']);
  await expect.poll(() => titlesIn(page, 'To do')).toEqual(['Card B', 'Card C', 'Card A']);

  await dragWithKeyboard(page, 'Card B', ['ArrowRight']);
  await expect.poll(() => titlesIn(page, 'In progress')).toEqual(['Card B']);
  await expect.poll(() => titlesIn(page, 'To do')).toEqual(['Card C', 'Card A']);

  await page.reload();
  await expect.poll(() => titlesIn(page, 'In progress')).toEqual(['Card B']);
  await expect.poll(() => titlesIn(page, 'To do')).toEqual(['Card C', 'Card A']);
});

test('a card can be dragged with the mouse', async ({ as, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'pointer dragging is checked in Chromium; keyboard dragging runs everywhere',
  );
  const { board } = await seed(['First', 'Second', 'Third']);
  const { page } = await as('alice');
  await openBoard(page, board.id);

  const from = await page
    .getByRole('button', { name: 'Move card First', exact: true })
    .boundingBox();
  const to = await page.getByRole('link', { name: 'Third', exact: true }).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 20, from!.y + 20, { steps: 4 });
  await page.mouse.move(to!.x + 30, to!.y + to!.height + 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => titlesIn(page, 'To do')).toEqual(['Second', 'Third', 'First']);
});

test('when the server refuses a move the card goes back and the reason is shown', async ({
  as,
}) => {
  const { board } = await seed(['Stays', 'Tries to leave']);
  const { page } = await as('alice');
  await openBoard(page, board.id);
  await page.route('**/api/cards/*/move', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'forbidden', message: 'You do not have permission to do this' },
      }),
    }),
  );
  await dragWithKeyboard(page, 'Tries to leave', ['ArrowRight']);
  await expect(page.getByText(/could not be moved/i)).toBeVisible();
  await expect(page.getByText(/do not have permission/i)).toBeVisible();
  await expect.poll(() => titlesIn(page, 'To do')).toEqual(['Stays', 'Tries to leave']);
  await expect.poll(() => titlesIn(page, 'In progress')).toEqual([]);
});

type Move = { cardId: string; columnId: string; afterId: string | null; beforeId: string | null };

/** Sends the moves one after another from INSIDE the page, as that browser session. */
const runMoves = (page: Page, moves: Move[]) =>
  page.evaluate(async (list) => {
    const statuses: number[] = [];
    for (const move of list) {
      const response = await fetch(`/api/cards/${move.cardId}/move`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          columnId: move.columnId,
          afterId: move.afterId,
          beforeId: move.beforeId,
        }),
      });
      statuses.push(response.status);
    }
    return statuses;
  }, moves);

const randomMoves = (ids: string[], columns: Column[], count: number): Move[] => {
  const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;
  return Array.from({ length: count }, () => ({
    cardId: pick(ids),
    columnId: pick(columns.slice(0, 2)).id,
    afterId: Math.random() < 0.7 ? pick(ids) : null,
    beforeId: Math.random() < 0.7 ? pick(ids) : null,
  }));
};

test('two browsers making 50 random moves each at the same moment end with the same order, equal to the database', async ({
  as,
}) => {
  test.setTimeout(150_000);
  const titles = Array.from({ length: 12 }, (_, i) => `Shuffle ${String(i + 1).padStart(2, '0')}`);
  const { api, board, ids } = await seed(titles);
  const [alice, bob] = [await as('alice'), await as('bob')];
  await Promise.all([openBoard(alice.page, board.id), openBoard(bob.page, board.id)]);

  const [aliceStatuses, bobStatuses] = await Promise.all([
    runMoves(alice.page, randomMoves(ids, board.columns, 50)),
    runMoves(bob.page, randomMoves(ids, board.columns, 50)),
  ]);
  expect([...aliceStatuses, ...bobStatuses].every((status) => status === 200)).toBe(true);

  const fromDatabase = async (name: string) => {
    const snapshot = await json<{
      columns: Column[];
      cards: { title: string; columnId: string; position: string; id: string }[];
    }>(await api.get(`/api/boards/${board.id}`));
    const columnId = snapshot.columns.find((column) => column.name === name)!.id;
    return snapshot.cards
      .filter((card) => card.columnId === columnId)
      .sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
      )
      .map((card) => card.title);
  };
  for (const name of ['To do', 'In progress']) {
    const expected = await fromDatabase(name);
    await expect
      .poll(() => titlesIn(alice.page, name), {
        timeout: 20_000,
        message: `Alice's "${name}" column`,
      })
      .toEqual(expected);
    await expect
      .poll(() => titlesIn(bob.page, name), { timeout: 20_000, message: `Bob's "${name}" column` })
      .toEqual(expected);
  }
  expect((await fromDatabase('To do')).length + (await fromDatabase('In progress')).length).toBe(
    12,
  ); // nothing lost, nothing doubled
});
