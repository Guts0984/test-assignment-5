import { apiAs, json } from '../src/support/api';
import { column, dragWithKeyboard, openBoard } from '../src/support/board';
import { expect, test } from '../src/support/test';

test('the seeded board with 1,000 cards opens with a small page and scrolls and drags smoothly', async ({
  as,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'frame timing is measured in Chromium');
  test.setTimeout(120_000);
  const api = await apiAs('alice');
  const workspaces = await json<{ boards: { id: string; name: string }[] }[]>(
    await api.get('/api/workspaces'),
  );
  const roadmap = workspaces.flatMap((w) => w.boards).find((b) => b.name === 'Roadmap')!;

  const { page } = await as('alice');
  const started = Date.now();
  await openBoard(page, roadmap.id);
  const openedIn = Date.now() - started;
  await expect(page.getByRole('heading', { name: /^Backlog \(\d+\)/ })).toBeVisible();

  const total = await page.locator('section a').count();
  const backlog = await column(page, 'Backlog').getByRole('link').count();
  expect(total, 'only the visible cards are in the page, not all 1,000').toBeLessThan(200);
  expect(backlog).toBeLessThan(60);
  // Generous: the other worker may be running heavy tests on the same stack at this moment.
  expect(openedIn, 'time until the board is live').toBeLessThan(30_000);

  // Scroll the long column from top to bottom, timing every frame. The machine also runs the
  // other tests' browsers, so a noisy pass is repeated: real jank shows in every attempt, a
  // busy moment does not.
  const scroller = column(page, 'Backlog').locator('div.overflow-y-auto');
  const measure = () =>
    scroller.evaluate(
      (element) =>
        new Promise<{ p95: number; worst: number; frames: number }>((resolve) => {
          element.scrollTop = 0;
          const deltas: number[] = [];
          let last = performance.now();
          let step = 0;
          const tick = () => {
            const now = performance.now();
            deltas.push(now - last);
            last = now;
            element.scrollTop = (element.scrollHeight / 80) * (step += 1);
            if (step < 80) requestAnimationFrame(tick);
            else {
              const sorted = [...deltas].sort((a, b) => a - b);
              resolve({
                p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
                worst: sorted.at(-1) ?? 0,
                frames: sorted.length,
              });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
  const attempts: { p95: number; worst: number; frames: number }[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    attempts.push(await measure());
    if (attempts.at(-1)!.p95 < 100 && attempts.at(-1)!.worst < 500) break;
    await page.waitForTimeout(1_000);
  }
  const best = attempts.reduce((a, b) => (a.p95 <= b.p95 ? a : b));
  expect(
    best.p95,
    `95th percentile frame time while scrolling, best of ${attempts.length}: ${JSON.stringify(attempts)}`,
  ).toBeLessThan(100);
  expect(best.worst, JSON.stringify(attempts)).toBeLessThan(500);

  // Long tasks (the main thread blocked) during a keyboard drag in the big column.
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
    new PerformanceObserver((list) =>
      list
        .getEntries()
        .forEach((entry) =>
          (window as unknown as { __long: number[] }).__long.push(entry.duration),
        ),
    ).observe({ entryTypes: ['longtask'] });
  });
  await column(page, 'Backlog')
    .locator('div.overflow-y-auto')
    .evaluate((element) => (element.scrollTop = 0));
  await page.waitForTimeout(500); // let the virtual list draw the top of the column
  const first = (await column(page, 'Backlog').getByRole('link').first().innerText()).trim();
  await dragWithKeyboard(page, first, ['ArrowDown', 'ArrowDown', 'ArrowDown']);
  await expect
    .poll(
      async () =>
        (await column(page, 'Backlog').getByRole('link').allTextContents()).indexOf(first),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  expect(
    long.filter((duration) => duration > 200),
    `long tasks during the drag: ${JSON.stringify(long)}`,
  ).toHaveLength(0);
});
