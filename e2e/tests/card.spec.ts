import { addCard, apiAs, createBoard } from '../src/support/api';
import { openCardPage } from '../src/support/board';
import { expect, test } from '../src/support/test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const EXE = Buffer.concat([
  Buffer.from('MZ'),
  Buffer.alloc(600, 0x90),
  Buffer.from('This program cannot be run in DOS mode.'),
]);

const newCard = async (title = 'Original') => {
  const api = await apiAs('alice');
  const board = await createBoard(api, 'card');
  const card = await addCard(api, board.id, board.columns[0]!.id, title);
  return { board, card, path: `/boards/${board.id}/cards/${card.id}` };
};

test('a card opens in a window over the board, and as a page of its own when its address is opened directly', async ({
  as,
}) => {
  const { board, card, path } = await newCard('Opens twice');
  const { page } = await as('alice');
  await page.goto(`/boards/${board.id}`);
  await page.getByRole('link', { name: 'Opens twice' }).click();
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/cards/${card.id}`));
  await expect(page.locator('a', { hasText: 'Opens twice' })).toBeVisible(); // the board is still there behind it (hidden from screen readers while the window is open)
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));

  await openCardPage(page, path); // direct visit: no window, a page
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Title')).toHaveValue('Opens twice');
});

test('editing a card that someone else changed shows their version and keeps what I typed', async ({
  as,
}) => {
  const { path } = await newCard('Original');
  const [alice, bob] = [await as('alice'), await as('bob')];
  await Promise.all([alice.page.goto(path), bob.page.goto(path)]);
  await expect(bob.page.getByLabel('Title')).toHaveValue('Original');

  await alice.page.getByLabel('Title').fill('Alice was first');
  await alice.page.getByRole('button', { name: 'Save' }).click();
  await expect(alice.page.getByText('Saved.')).toBeVisible();

  await bob.page.getByLabel('Title').fill('Bob was second');
  await bob.page
    .getByLabel('Description')
    .fill('Bob wrote a long description and does not want to lose it');
  await bob.page.getByRole('button', { name: 'Save' }).click();

  const conflict = bob.page
    .getByRole('alert')
    .filter({ hasText: 'Someone else changed this card' });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('Alice was first'); // their version is shown
  await expect(bob.page.getByLabel('Title')).toHaveValue('Bob was second'); // and nothing typed was lost
  await expect(bob.page.getByLabel('Description')).toHaveValue(
    'Bob wrote a long description and does not want to lose it',
  );

  await conflict.getByRole('button', { name: 'Save mine over theirs' }).click();
  await expect(conflict).toBeHidden();
  await bob.page.reload();
  await expect(bob.page.getByLabel('Title')).toHaveValue('Bob was second');
});

test('a comment can mention a teammate, and the mention is highlighted', async ({ as }) => {
  const { path } = await newCard('Discussed');
  const { page } = await as('alice');
  await openCardPage(page, path);
  await page.getByLabel('Add a comment').fill('Please take a look @bob and ignore @nobody');
  await page.getByRole('button', { name: 'Comment' }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'Please take a look' });
  await expect(item).toBeVisible();
  await expect(item.locator('strong')).toHaveText('@bob'); // only a real teammate is highlighted
});

test('a file is attached with progress and can be downloaded with the same content', async ({
  as,
  browserName,
}) => {
  const { path } = await newCard('With a file');
  const { page } = await as('alice');
  await openCardPage(page, path);
  await page
    .getByLabel('Attach an image or PDF (up to 10 MB)')
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('pixel.png')).toBeVisible();

  if (browserName === 'webkit') {
    // Playwright's WebKit does not raise its "download" event for a navigation that ends in an
    // attachment, although the browser handles it. Check what the browser is actually given: the
    // signed link answers with the same bytes and a Content-Disposition: attachment header.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('X-Amz-Signature')),
      page.getByRole('button', { name: 'Download pixel.png' }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-disposition']).toMatch(/^attachment; filename="pixel\.png"/);
    expect((await response.body()).equals(PNG)).toBe(true);
    return;
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download pixel.png' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('pixel.png');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
});

test('files that are not images or PDFs are refused: by the browser, and by the server even when disguised', async ({
  as,
}) => {
  const { path } = await newCard('Refuses files');
  const { page } = await as('alice');
  await openCardPage(page, path);
  const input = page.getByLabel('Attach an image or PDF (up to 10 MB)');

  // The page may still be hydrating when the first file is chosen; retry until the handler is live.
  await expect(async () => {
    await input.setInputFiles({
      name: 'page.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<h1>hi</h1>'),
    });
    await expect(page.getByText(/Only images .* and PDF/)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  await input.setInputFiles({ name: 'holiday.png', mimeType: 'image/png', buffer: EXE }); // an .exe renamed to .png
  await expect(page.getByText(/could not be attached/i)).toBeVisible();
  await expect(page.getByText('holiday.png')).toHaveCount(0);

  await input.setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(11 * 1024 * 1024, 1),
  }); // 11 MB
  await expect(page.getByText('Files can be at most 10 MB.')).toBeVisible();
  await expect(page.getByText('huge.png')).toHaveCount(0);
});

test('deleting a card removes it from the board', async ({ as }) => {
  const { board, path } = await newCard('Delete me');
  const { page } = await as('alice');
  await openCardPage(page, path);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete card' }).click();
  await expect(page).toHaveURL(new RegExp(`/boards/${board.id}$`));
  await expect(page.getByRole('link', { name: 'Delete me' })).toHaveCount(0);
});
