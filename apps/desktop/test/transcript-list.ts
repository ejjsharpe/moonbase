import { expect, type Page } from '@playwright/test';

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

/**
 * Opens the latest card whose headline names `tool`, with a pointer on its chevron as a reader
 * does. A call's output in a later row (the live response, say) has no chevron and opens with it.
 */
export async function openCallCard(page: Page, tool: string) {
  const toggle = page
    .locator('[data-transcript-row]')
    .filter({ has: page.getByRole('listitem').filter({ hasText: tool }) })
    .last()
    .getByRole('button', { name: /^Activity/ });
  await toggle.click();
  return toggle;
}
