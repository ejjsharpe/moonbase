import { expect, type Locator, type Page } from '@playwright/test';

export const transcriptList = (page: Page) =>
  page.getByRole('region', { name: 'Chat transcript', exact: true });

/** Scrolls the transcript to its start with the wheel, as a reader does, until no earlier history is left. */
export async function scrollToStart(page: Page) {
  const list = transcriptList(page);
  await list.hover();
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -100000);
        return page.evaluate(() => {
          const { earlier, loading } = window.demo.application.chat!.getSnapshot().transcript;
          const node = document.querySelector('[aria-label="Chat transcript"]')!;
          return !earlier && !loading && node.scrollTop < 1;
        });
      },
      { timeout: 15000 },
    )
    .toBe(true);
}

/**
 * Scrolls the transcript to its end with the wheel, no further than the end: Chromium keeps an
 * overshooting wheel's target past the end, and the next wheel up is spent against it.
 */
export async function scrollToEnd(page: Page) {
  const list = transcriptList(page);
  const readFromEnd = () =>
    list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  await list.hover();
  await expect
    .poll(
      async () => {
        const remaining = Math.floor(await readFromEnd());
        if (remaining > 0) await page.mouse.wheel(0, remaining);
        return readFromEnd();
      },
      { timeout: 15000 },
    )
    .toBeLessThan(30);
}

/**
 * Waits until the mounted rows are in the page in the order they show. The list places rows as it
 * scrolls and sorts them in the page once scrolling rests, and a selection follows page order.
 */
export async function waitForRowOrder(page: Page) {
  await expect
    .poll(() =>
      transcriptList(page).evaluate((node) => {
        const tops = [...node.querySelectorAll('[data-transcript-row]')].map(
          (row) => row.getBoundingClientRect().top,
        );
        return tops.every((top, index) => index === 0 || top >= tops[index - 1]!);
      }),
    )
    .toBe(true);
}

/**
 * Waits until the list rests: its scroll position, height and mounted rows' places unchanged for
 * several frames in a row, as they are once it has laid out and scrolled what it shows.
 */
export async function waitForListRest(page: Page) {
  await transcriptList(page).evaluate(
    (node) =>
      new Promise<void>((resolve) => {
        const read = () =>
          [
            node.scrollTop,
            node.scrollHeight,
            ...[...node.querySelectorAll<HTMLElement>('[data-transcript-row]')].map(
              (row) => `${row.dataset.transcriptRow}@${row.getBoundingClientRect().top}`,
            ),
          ].join();
        let last = read(),
          still = 0;
        const check = () => {
          const now = read();
          still = now === last ? still + 1 : 0;
          last = now;
          if (still === 10) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

/**
 * Scrolls up with the wheel until the row with `key` is in view, most of a screen at a time, so
 * each screen overlaps the one before and no row is passed over.
 */
export async function showRow(page: Page, key: string) {
  const list = transcriptList(page);
  await list.hover();
  await expect
    .poll(
      async () => {
        const { visible, screen } = await list.evaluate((node, key) => {
          const row = node.querySelector(`[data-transcript-row="${key}"]`);
          const view = node.getBoundingClientRect();
          if (!row) return { visible: false, screen: view.height };
          const box = row.getBoundingClientRect();
          return { visible: box.bottom > view.top && box.top < view.bottom, screen: view.height };
        }, key);
        if (!visible) await page.mouse.wheel(0, -Math.round(screen * 0.8));
        return visible;
      },
      { timeout: 15000, intervals: [100] },
    )
    .toBe(true);
}

/** Clicks the first of `closed` until none are left, and fails if any stay. */
async function clickUntilNone(closed: Locator) {
  for (let i = 0; i < 1000 && (await closed.count()); i++) await closed.first().click();
  await expect(closed).toHaveCount(0);
}

/** Opens every folded run of tool rows ("Worked for …"), so the steps inside are shown. */
export async function openActivityGroups(page: Page) {
  await clickUntilNone(page.locator('[data-transcript-activity-group][aria-expanded="false"]'));
}

/** Opens folded runs, then every closed step in the scope, so all their recorded parts show. */
export async function openActivity(scope: Locator) {
  await openActivityGroups(scope.page());
  // A call's output in a later row has no opener of its own; it opens with its call.
  await clickUntilNone(scope.getByRole('button', { name: /^Activity/, expanded: false }));
}

/** The opener of the step that holds a recorded part. */
export const stepToggle = (scope: Locator, partId: string) =>
  scope
    .locator('[data-transcript-step]')
    .filter({ has: scope.page().locator(`[data-transcript-part="${partId}"]`) })
    .getByRole('button', { name: /^Activity/ });

/**
 * Waits until the running response records `ready` or folds its work under "Working…", and opens
 * that fold. A response that is only tool work so far folds; one with an answer shows its parts.
 */
export async function openWorkingFold(page: Page, ready: Locator) {
  const fold = page.locator('[data-transcript-activity-group]', { hasText: /^Working/ });
  await expect.poll(async () => (await fold.isVisible()) || (await ready.count()) > 0).toBe(true);
  if ((await fold.count()) && (await fold.getAttribute('aria-expanded')) !== 'true')
    await fold.click();
}

/**
 * Opens the latest stored call whose headline names `tool`, with a pointer on its chevron as a
 * reader does, once the call is stored. A call's output in a later row (the live response, say)
 * has no chevron and opens with it.
 */
export async function openCallCard(page: Page, tool: string) {
  const line = page
    .locator('[data-transcript-row^="entry:"] [data-transcript-step] > [data-glyph]')
    .filter({ hasText: tool })
    .last();
  await expect(line).toBeAttached();
  await openActivityGroups(page);
  const toggle = line.getByRole('button', { name: /^Activity/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  return toggle;
}
