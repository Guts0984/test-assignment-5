import { expect, type Locator, type Page } from '@playwright/test';

/** The column named `name` (its heading reads "name (count)"). */
export const column = (page: Page, name: string): Locator =>
  page.locator('section', { has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });

/** Card titles in a column, top to bottom, as shown on screen. */
export const titlesIn = (page: Page, name: string): Promise<string[]> =>
  column(page, name).getByRole('link').allTextContents();

/**
 * Drags a card with the keyboard, the way a keyboard user would: focus its handle, Space to pick it
 * up, arrows to move (Down/Up within a column, Right/Left to another one), Space to drop.
 */
export const dragWithKeyboard = async (
  page: Page,
  title: string,
  keys: string[],
): Promise<void> => {
  const handle = page.getByRole('button', { name: `Move card ${title}`, exact: true });
  const announcement = page.locator('[id^="DndLiveRegion"]');
  await handle.focus();
  await page.keyboard.press('Space');
  // "is over ..." is announced once dnd-kit has measured the drop targets; arrow keys pressed
  // before that find nothing to move to and the card is dropped where it was.
  await expect(announcement).toContainText('is over');
  for (const key of keys) {
    const before = await announcement.textContent();
    await page.keyboard.press(key);
    // dnd-kit announces where the card is now ("... is over In progress"); drop only after it
    // changed, so a slow machine cannot drop the card at its previous position.
    await expect
      .poll(() => announcement.textContent(), { timeout: 5_000 })
      .not.toBe(before)
      .catch(() => undefined); // an arrow that changes nothing (edge of the board) announces nothing
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Space');
};

export const openBoard = async (page: Page, boardId: string): Promise<void> => {
  await page.goto(`/boards/${boardId}`);
  await page.getByRole('status').filter({ hasText: 'Live' }).waitFor(); // the socket has joined the board
};

/**
 * Opens a card as a page of its own and waits until the page is interactive: the attachment list
 * is fetched by the browser, so once it has loaded, React has taken over the server-rendered HTML.
 */
export const openCardPage = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await page.getByRole('heading', { name: 'Attachments' }).waitFor();
  await page.getByText('Loading attachments…').waitFor({ state: 'hidden' });
};

/**
 * Waits until React has taken over this element: server-rendered HTML can be typed into before
 * hydration, and hydration then wipes what was typed. React marks every DOM node it owns.
 */
export const hydrated = async (target: Locator): Promise<void> => {
  await expect
    .poll(() =>
      target.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactFiber$'))),
    )
    .toBe(true);
};
