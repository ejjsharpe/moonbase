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

/** Scrolls the transcript to its end with the wheel. */
export async function scrollToEnd(page: Page) {
  const list = transcriptList(page);
  await list.hover();
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 100000);
        return list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
      },
      { timeout: 15000 },
    )
    .toBeLessThan(30);
}

/** Scrolls up with the wheel until the row with `key` is in view. */
export async function showRow(page: Page, key: string) {
  const list = transcriptList(page);
  await list.hover();
  await expect
    .poll(
      async () => {
        const visible = await list.evaluate((node, key) => {
          const row = node.querySelector(`[data-transcript-row="${key}"]`);
          if (!row) return false;
          const box = row.getBoundingClientRect(),
            view = node.getBoundingClientRect();
          return box.bottom > view.top && box.top < view.bottom;
        }, key);
        if (!visible) await page.mouse.wheel(0, -300);
        return visible;
      },
      { timeout: 15000, intervals: [100] },
    )
    .toBe(true);
}

/** Opens every folded run of tool rows ("Worked for …"), so the steps inside are shown. */
export async function openActivityGroups(page: Page) {
  const closed = page.locator('[data-transcript-activity-group][aria-expanded="false"]');
  for (let i = 0; i < 50 && (await closed.count()); i++) await closed.first().click();
}

/** Opens folded runs, then every closed step in the scope, so all their recorded parts show. */
export async function openActivity(scope: Locator) {
  await openActivityGroups(scope.page());
  const closed = scope.getByRole('button', { name: /^Activity/, expanded: false });
  // An output step's opener is visually hidden (clipped away) and opens from the keyboard.
  for (let i = 0; i < 50 && (await closed.count()); i++) {
    const opener = closed.first();
    if (await opener.evaluate((node) => getComputedStyle(node).clipPath !== 'none'))
      await opener.press('Enter');
    else await opener.click();
  }
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
