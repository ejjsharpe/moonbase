import { disconnectChat } from './chat-target.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFindHighlight } from './find-highlight.ts';
import {
  scrollToEnd,
  scrollToStart,
  showRow,
  transcriptList,
  waitForRowOrder,
  openActivity,
} from './transcript-list.ts';
import type * as readingPins from '../src/renderer/chat/reading-pin.ts';

type ReadingPins = typeof readingPins;
const output = resolve('../../test-results/transcript-111');
const imagePng = (
  await readFile(new URL('./fixtures/images/checker.png', import.meta.url))
).toString('base64');
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
  await openActivity(answer(page));
  // Expanding the activity can move the reader off the end.
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  // It can also settle back by itself between seeing the button and clicking it.
  if (await jump.isVisible()) await jump.click({ timeout: 2000 }).catch(() => undefined);
  await expect(jump).toBeHidden();
}
const transcript = (page: Page) =>
  page.getByRole('region', { name: 'Chat transcript', exact: true });
const answer = (page: Page) => page.locator('[data-transcript-entry="reading-179"]');
/** Opens the demo's long conversation (2,000 alternating questions and answers by default). */
async function openLong(page: Page, count?: number) {
  await page.goto(`/?local&design&transcript&long${count ? `=${count}` : ''}`);
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(transcriptList(page)).toBeVisible();
  await expect(
    page.locator(`[data-transcript-row="entry:long-${(count ?? 2000) - 1}"]`),
  ).toBeVisible();
}
/** The scroller's position: pixels from its end, and the mounted row keys. */
const readList = (page: Page) =>
  transcriptList(page).evaluate((node) => ({
    top: node.scrollTop,
    fromEnd: node.scrollHeight - node.scrollTop - node.clientHeight,
    rows: [...node.querySelectorAll<HTMLElement>('[data-transcript-row]')].map(
      (row) => row.dataset.transcriptRow!,
    ),
  }));
/** The first part whose bottom is below the scroller's top, and its offset from that top. */
const readFirstVisible = (page: Page) =>
  transcriptList(page).evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const part = [...node.querySelectorAll<HTMLElement>('[data-transcript-part]')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .find((part) => part.getBoundingClientRect().bottom > top)!;
    return {
      row: part.closest<HTMLElement>('[data-transcript-row]')!.dataset.transcriptRow!,
      part: part.dataset.transcriptPart!,
      offset: part.getBoundingClientRect().top - top,
    };
  });
const savedAnchor = (page: Page) =>
  page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor);
const jumpButton = (page: Page) =>
  page.getByRole('button', { name: 'Jump to latest', exact: true });
/** Scrolls up by `pixels` with the wheel and waits for the list to rest. */
async function wheelUp(page: Page, pixels: number) {
  await transcriptList(page).hover();
  await page.mouse.wheel(0, -pixels);
  await expect.poll(async () => (await readList(page)).fromEnd).toBeGreaterThan(pixels / 2);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
}

/** Reports the page hidden or visible, as Electron does for a minimised or covered window. */
const setWindowHidden = (page: Page, hidden: boolean) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
declare global {
  interface Window {
    transcriptKept?: { list: Element; cleared: boolean };
  }
}
/** Marks the mounted list and notes whether the chat's transcript is ever cleared from here on. */
const watchTranscriptKept = (page: Page) =>
  page.evaluate(() => {
    const chat = window.demo.application.chat!;
    const kept: NonNullable<Window['transcriptKept']> = {
      list: document.querySelector('[data-transcript-list]')!,
      cleared: false,
    };
    window.transcriptKept = kept;
    chat.subscribe(() => {
      const { snapshot, transcript } = chat.getSnapshot();
      if (!snapshot || !transcript.rows.length) kept.cleared = true;
    });
    new MutationObserver(() => {
      if (document.body.textContent!.includes('Reading the saved chat…')) kept.cleared = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
const readTranscriptKept = (page: Page) =>
  page.evaluate(() => {
    const kept = window.transcriptKept!;
    return { mounted: kept.list.isConnected, cleared: kept.cleared };
  });
const viewTab = (page: Page, name: string) =>
  page
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .getByRole('tab', { name, exact: true });
/** Closes the project's chat dock, so leaving Agents for the project shows no chat view. */
async function closeProjectDock(page: Page) {
  await viewTab(page, 'moonbase · main').click();
  await page
    .getByRole('complementary', { name: 'Project chats', exact: true })
    .getByRole('button', { name: 'Hide project chats', exact: true })
    .click();
  await viewTab(page, 'Agents').click();
  await expect(transcriptList(page)).toBeVisible();
}

test.describe('the virtualized transcript', () => {
  test('mounts a bounded number of rows across a full scroll', async ({ page }) => {
    test.setTimeout(180000);
    await openLong(page);
    let most = 0;
    const list = transcriptList(page);
    await list.hover();
    for (let step = 0; step < 400; step++) {
      await page.mouse.wheel(0, -4000);
      const { rows } = await readList(page);
      most = Math.max(most, rows.length);
      const { earlier, loading } = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript,
      );
      if (!earlier && !loading && (await list.evaluate((node) => node.scrollTop)) < 1) break;
    }
    await expect(page.locator('[data-transcript-row="entry:long-0"]')).toBeVisible();
    const retained = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.entries.length,
    );
    expect(retained).toBeLessThanOrEqual(1024);
    expect(most).toBeGreaterThan(3);
    expect(most).toBeLessThan(40);
    await expect(page.locator('[data-transcript-entry]').first()).toBeAttached();
    expect(await page.locator('[data-transcript-entry]').count()).toBeLessThan(40);
  });

  test('opens at the end and follows while the live row grows', async ({ page }) => {
    await openLong(page, 200);
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    await expect(jumpButton(page)).toHaveCount(0);
    for (let step = 1; step <= 6; step++) {
      await page.evaluate(
        (step) =>
          window.demo.transcript!.live('Streaming reply\n\n' + 'more words '.repeat(step * 120)),
        step,
      );
      await expect(page.locator('[data-transcript-live]')).toContainText('Streaming reply');
      // At the real end: nothing is left to scroll below the live row.
      await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    }
    expect(await savedAnchor(page)).toBeNull();
  });

  test('a streaming reply never shrinks back to its preview between updates', async ({ page }) => {
    await openLong(page, 40);
    const shown = await page.evaluate(async () => {
      const list = document.querySelector('[data-transcript-list]')!;
      const lengths: number[] = [];
      const observer = new MutationObserver(() => {
        const live = list.querySelector('[data-transcript-live]');
        if (live) lengths.push(live.textContent!.length);
      });
      observer.observe(list, { subtree: true, childList: true, characterData: true });
      let text = 'Streaming reply\n\n';
      for (let step = 0; step < 12; step++) {
        text += 'more streaming words arrive here. ';
        await window.demo.transcript!.live(text);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      observer.disconnect();
      return lengths;
    });
    // The demo's previews are 64 characters, so every update after the first would shrink to one.
    expect(shown.at(-1)).toBeGreaterThan(300);
    expect(shown.filter((length, index) => index > 0 && length < shown[index - 1]!)).toEqual([]);
  });

  test('a streaming reply renders from its snapshot without reading its text', async ({ page }) => {
    await openLong(page, 40);
    const result = await page.evaluate(async () => {
      const client = window.demo.chat.dependencies.chat,
        original = client.command;
      let reads = 0;
      client.command = async (operation, input, options) => {
        const request = input as { source?: { kind?: string }; selection?: unknown };
        if (
          operation === 'getChatTranscriptContent' &&
          request.source?.kind === 'live' &&
          request.selection
        )
          reads++;
        return original(operation, input, options) as never;
      };
      let text = 'Streaming reply\n\n';
      for (let step = 0; step < 12; step++) {
        text += 'more streaming words arrive here. ';
        await window.demo.transcript!.live(text);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.command = original;
      return { reads, shown: document.querySelector('[data-transcript-live]')!.textContent! };
    });
    expect(result.reads).toBe(0);
    expect(result.shown).toContain('more streaming words arrive here. '.repeat(12).trim());
  });

  test('following a streaming reply never moves the text back down', async ({ page }) => {
    await openLong(page, 40);
    const text = 'Streaming reply\n\n' + 'more streaming words arrive here. '.repeat(4);
    await page.evaluate((text) => window.demo.transcript!.live(text), text);
    await expect(page.locator('[data-transcript-live]')).toContainText('more streaming words');
    const moves = await page.evaluate(async (text) => {
      const list = document.querySelector('[data-transcript-list]')!;
      const above = list.querySelector('[data-transcript-row="entry:long-39"]')!;
      // Each frame, where the row above the reply sits: following only ever moves it up.
      const tops: number[] = [];
      let sampling = true;
      const sample = () => {
        tops.push(above.getBoundingClientRect().top - list.getBoundingClientRect().top);
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      for (let step = 0; step < 40; step++) {
        text += 'more streaming words arrive here. ';
        await window.demo.transcript!.live(text);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      sampling = false;
      return tops.flatMap((top, index) =>
        index && top > tops[index - 1]! + 1 ? [Math.round(top - tops[index - 1]!)] : [],
      );
    }, text);
    // A status line under the reply while each revision loads was measured and then dropped, so
    // the list followed an end 43px too far and fell back as the reply grew.
    expect(moves).toEqual([]);
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
  });

  test('a finished reply keeps the text it streamed while its stored text loads', async ({
    page,
  }) => {
    await openLong(page, 20);
    const shown = await page.evaluate(async () => {
      const transcript = window.demo.transcript!;
      // The demo's long conversation, as `long(20)` records it.
      const records = Array.from({ length: 20 }, (_, index) => {
        const user = index % 2 === 0;
        let text = user
          ? `Question ${index}: how does part ${index} fit together?`
          : `Answer ${index}.\n\n` + 'A paragraph of steady explanation. '.repeat(1 + (index % 7));
        if (!user && index % 10 === 1)
          text +=
            '\n\n```typescript\n' +
            Array.from({ length: 60 }, (_, line) => `const line${line} = ${index};`).join('\n') +
            '\n```\n';
        if (index === 5) text += '\n\nThe old lighthouse note.';
        const role = user ? ('user' as const) : ('assistant' as const);
        return { id: `long-${index}`, role, parts: [{ text, kind: 'text' as const, role }] };
      });
      const list = document.querySelector('[data-transcript-list]')!;
      let text = 'Finished reply\n\n';
      for (let step = 0; step < 10; step++) {
        text += 'more streaming words arrive here. ';
        await transcript.live(text);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const live = list.querySelector('[data-transcript-live]')!.textContent!.length;
      const lengths: number[] = [];
      const observer = new MutationObserver(() => {
        const reply = [...list.querySelectorAll('article')].find((article) =>
          article.textContent!.includes('Finished reply'),
        );
        lengths.push(reply?.textContent!.length ?? 0);
      });
      observer.observe(list, { subtree: true, childList: true, characterData: true });
      await transcript.record([
        ...records,
        { id: 'finished', role: 'assistant', parts: [{ text, kind: 'text', role: 'assistant' }] },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      observer.disconnect();
      return { lengths, live };
    });
    await expect(page.locator('[data-transcript-row="entry:finished"]')).toContainText(
      'more streaming words',
    );
    // The demo's previews are 64 characters; the stored reply never shows only its preview.
    expect(Math.min(...shown.lengths)).toBeGreaterThanOrEqual(shown.live);
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
  });

  test('scrolling up stops following, and new output does not move the reader', async ({
    page,
  }) => {
    await openLong(page, 200);
    await page.evaluate(() => window.demo.transcript!.live('Streaming reply'));
    await wheelUp(page, 1500);
    await expect(jumpButton(page)).toBeVisible();
    await expect.poll(() => savedAnchor(page)).not.toBeNull();
    const before = await readFirstVisible(page);
    for (let step = 1; step <= 4; step++)
      await page.evaluate(
        (step) =>
          window.demo.transcript!.live('Streaming reply\n\n' + 'more words '.repeat(step * 200)),
        step,
      );
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const after = await readFirstVisible(page);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
  });

  test('hiding and showing the window keeps the transcript and follows a running reply', async ({
    page,
  }) => {
    await openLong(page, 200);
    await page.evaluate(() => window.demo.transcript!.live('Streaming reply'));
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    await watchTranscriptKept(page);
    await setWindowHidden(page, true);
    for (let step = 1; step <= 4; step++)
      await page.evaluate(
        (step) =>
          window.demo.transcript!.live(
            'Streaming reply\n\n' + 'more words '.repeat(step * 200) + `step ${step}`,
          ),
        step,
      );
    await setWindowHidden(page, false);
    await expect(page.locator('[data-transcript-live]')).toContainText('step 4');
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    expect(await readTranscriptKept(page)).toEqual({ mounted: true, cleared: false });
    await expect(jumpButton(page)).toHaveCount(0);
  });

  test('hiding and showing the window keeps the reader in place', async ({ page }) => {
    await openLong(page, 200);
    await wheelUp(page, 1500);
    await expect.poll(() => savedAnchor(page)).not.toBeNull();
    const before = await readFirstVisible(page);
    await watchTranscriptKept(page);
    await setWindowHidden(page, true);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await setWindowHidden(page, false);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const after = await readFirstVisible(page);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
    expect(await readTranscriptKept(page)).toEqual({ mounted: true, cleared: false });
  });

  test('a project view and back keeps the transcript and follows a running reply', async ({
    page,
  }) => {
    await openLong(page, 200);
    await closeProjectDock(page);
    await page.evaluate(() => window.demo.transcript!.live('Streaming reply'));
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    await watchTranscriptKept(page);
    await viewTab(page, 'moonbase · main').click();
    await expect(transcriptList(page)).toBeHidden();
    for (let step = 1; step <= 4; step++)
      await page.evaluate(
        (step) =>
          window.demo.transcript!.live(
            'Streaming reply\n\n' + 'more words '.repeat(step * 200) + `step ${step}`,
          ),
        step,
      );
    await viewTab(page, 'Agents').click();
    await expect(page.locator('[data-transcript-live]')).toContainText('step 4');
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    expect(await readTranscriptKept(page)).toEqual({ mounted: true, cleared: false });
    await expect(jumpButton(page)).toHaveCount(0);
  });

  test('a project view and back keeps the reader in place', async ({ page }) => {
    await openLong(page, 200);
    await closeProjectDock(page);
    await wheelUp(page, 1500);
    await expect.poll(() => savedAnchor(page)).not.toBeNull();
    const before = await readFirstVisible(page);
    await watchTranscriptKept(page);
    await viewTab(page, 'moonbase · main').click();
    await expect(transcriptList(page)).toBeHidden();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await viewTab(page, 'Agents').click();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const after = await readFirstVisible(page);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
    expect(await readTranscriptKept(page)).toEqual({ mounted: true, cleared: false });
    await expect(jumpButton(page)).toBeVisible();
  });

  test('a selection pauses following, and clearing it resumes', async ({ page }) => {
    await openLong(page, 200);
    await page.evaluate(() => window.demo.transcript!.live('Selected streaming reply'));
    const text = page
      .locator('[data-transcript-row="entry:long-199"] [data-transcript-part]')
      .first();
    await text.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.querySelector('p')!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const selected = await page.evaluate(() => window.getSelection()!.toString());
    expect(selected).toContain('Answer 199');
    const { top } = await readList(page);
    for (let step = 1; step <= 3; step++)
      await page.evaluate(
        (step) =>
          window.demo.transcript!.live(
            'Selected streaming reply\n\n' + 'growing '.repeat(step * 300),
          ),
        step,
      );
    await expect(page.locator('[data-transcript-live]')).toContainText('growing');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect((await readList(page)).top).toBe(top);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
    // Paused, not released: the reader still follows once the selection clears.
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await page.evaluate(() =>
      window.demo.transcript!.live('Selected streaming reply\n\n' + 'growing '.repeat(1200)),
    );
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(30);
  });

  test('scrolling to the top loads earlier pages and keeps the first visible part in place', async ({
    page,
  }) => {
    await openLong(page, 400);
    const loaded = () =>
      page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.entries.length);
    expect(await loaded()).toBe(32);
    const list = transcriptList(page);
    await list.hover();
    await page.mouse.wheel(0, -100000);
    await expect.poll(loaded).toBeGreaterThan(32);
    await expect
      .poll(() =>
        page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.loading),
      )
      .toBe(false);
    // The prepended page is above the reader: what they were reading has not moved.
    const before = await readFirstVisible(page);
    await page.evaluate(() => window.demo.application.chat!.showEarlier());
    await expect.poll(loaded).toBeGreaterThan(64);
    const after = await readFirstVisible(page);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
    await scrollToStart(page);
    await expect(page.locator('[data-transcript-row="entry:long-0"]')).toBeVisible();
    expect(await loaded()).toBe(400);
  });

  test('a disclosure toggled above the viewport does not move the reader', async ({ page }) => {
    await openLong(page, 200);
    // Answer 191 carries a 60-line code block that folds at 40 lines. Its trigger is placed just
    // above the viewport, still mounted.
    await showRow(page, 'entry:long-191');
    const code = page.locator('[data-transcript-row="entry:long-191"]');
    const trigger = code.getByRole('button', { name: /^Show all/ });
    await trigger.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await transcriptList(page).hover();
    await page.mouse.wheel(0, 120);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(
      await trigger.evaluate(
        (node) =>
          node.getBoundingClientRect().bottom <
          node.closest('[aria-label="Chat transcript"]')!.getBoundingClientRect().top,
      ),
    ).toBe(true);
    const before = await readFirstVisible(page);
    await trigger.evaluate((node) => (node as HTMLElement).click());
    await expect(code.getByRole('button', { name: 'Fold code' })).toBeAttached();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const after = await readFirstVisible(page);
    expect(after.row).toBe(before.row);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
  });

  // Rows sit at fractional positions while the list scrolls in whole pixels, so a restore lands a
  // fraction off at some sizes; reopening must still keep the saved anchor.
  for (const viewport of [
    { width: 1600, height: 1000 },
    { width: 1528, height: 1040 },
    { width: 1672, height: 960 },
  ])
    test(`reopening restores the reading position within a pixel at ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openLong(page, 400);
      await wheelUp(page, 2300);
      await expect.poll(() => savedAnchor(page)).not.toBeNull();
      const saved = (await savedAnchor(page))!;
      const before = await readFirstVisible(page);
      await page
        .getByRole('button', { name: 'Close Chat panel', exact: true })
        .locator('..')
        .hover();
      await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
      await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
      await expect(page.locator(`[data-transcript-row="${saved.key}"]`)).toBeVisible();
      await expect
        .poll(async () => {
          const after = await readFirstVisible(page);
          return after.part === before.part && after.row === before.row
            ? Math.abs(after.offset - before.offset)
            : Infinity;
        })
        .toBeLessThan(1);
      // The restore's own scroll end saves what the list reports; it must be the saved anchor.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(await savedAnchor(page)).toEqual(saved);
    });

  test('Jump to latest appears only while not following', async ({ page }) => {
    await openLong(page, 200);
    await expect(jumpButton(page)).toHaveCount(0);
    await wheelUp(page, 1200);
    await expect(jumpButton(page)).toBeVisible();
    await jumpButton(page).click();
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    await expect(jumpButton(page)).toHaveCount(0);
    expect(await savedAnchor(page)).toBeNull();
    await page.evaluate(() => window.demo.transcript!.live('After jumping'));
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
  });

  test('Jump to latest from the start lands at the real end', async ({ page }) => {
    await openLong(page, 200);
    await scrollToStart(page);
    await expect(jumpButton(page)).toBeVisible();
    await jumpButton(page).click();
    // Rows between were never measured, so the list's own scroll aims from estimates.
    await expect.poll(async () => (await readList(page)).fromEnd).toBeLessThan(1);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect((await readList(page)).fromEnd).toBeLessThan(1);
    await expect(jumpButton(page)).toHaveCount(0);
  });

  test('Find reveals a match in a row that is not mounted', async ({ page }) => {
    await openLong(page);
    await expect(page.locator('[data-transcript-row="entry:long-5"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Find in conversation', exact: true })
      .fill('lighthouse');
    const row = page.locator('[data-transcript-row="entry:long-5"]');
    await expect(row).toBeVisible();
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'lighthouse', entry: 'long-5', visible: true })]);
    // A match in a retained row that is scrolled away is revealed without a read.
    await page
      .getByRole('textbox', { name: 'Find in conversation', exact: true })
      .fill('Question 1970:');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ entry: 'long-1970', visible: true })]);
  });

  test('a cross-row selection keeps its rows mounted while scrolled away', async ({ page }) => {
    await openLong(page, 200);
    await showRow(page, 'entry:long-196');
    await waitForRowOrder(page);
    await page.evaluate(() => {
      const part = (key: string) =>
        document.querySelector(`[data-transcript-row="${key}"] [data-transcript-part]`)!;
      const start = part('entry:long-196'),
        end = part('entry:long-198');
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.childNodes.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const selected = await page.evaluate(() => window.getSelection()!.toString());
    expect(selected).toContain('Question 196');
    expect(selected).toContain('Answer 197');
    await scrollToStart(page);
    for (const key of ['entry:long-196', 'entry:long-197', 'entry:long-198'])
      await expect(page.locator(`[data-transcript-row="${key}"]`)).toBeAttached();
    await expect(page.locator('[data-transcript-row="entry:long-150"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
  });

  test('the list moving the focused row scrolled away keeps the reader in place', async ({
    page,
  }) => {
    await openLong(page, 200);
    const button = page
      .locator('[data-transcript-row="entry:long-199"]')
      .getByRole('button', { name: 'Copy message', exact: true });
    await button.focus();
    await wheelUp(page, 1200);
    const before = await readList(page);
    // The list sorts its containers into index order once scrolling settles, moving them as here;
    // Chromium scrolls a moved focused element back into view.
    await page.evaluate(() => {
      const container = document.activeElement!.closest('[data-transcript-row]')!.parentElement!;
      container.parentElement!.moveBefore(container, container.parentElement!.firstElementChild);
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const after = await readList(page);
    expect(Math.abs(after.top - before.top)).toBeLessThan(1);
    await expect(button).toBeFocused();
  });

  /** Records each reading anchor saved to view memory from now on. */
  const recordAnchors = (page: Page) =>
    page.evaluate(() => {
      const chat = window.demo.application.chat!;
      const saved: unknown[] = [];
      (window as typeof window & { savedAnchors?: unknown[] }).savedAnchors = saved;
      let last = chat.getSnapshot().transcript.view.anchor;
      chat.subscribe(() => {
        const { anchor } = chat.getSnapshot().transcript.view;
        if (anchor !== last) saved.push((last = anchor));
      });
    });
  const readSavedAnchors = (page: Page) =>
    page.evaluate(
      () => (window as typeof window & { savedAnchors?: ({ key: string } | null)[] }).savedAnchors!,
    );
  /** Whether the active Find match's text is inside the transcript's viewport. */
  const isActiveMatchInView = (page: Page) =>
    page.evaluate(() => {
      const painted = [...(CSS.highlights.get('find-active') ?? [])][0];
      if (!painted) return false;
      const range = document.createRange();
      range.setStart(painted.startContainer, painted.startOffset);
      range.setEnd(painted.endContainer, painted.endOffset);
      if (!range.toString()) return false;
      const box = range.getBoundingClientRect(),
        view = document.querySelector('[aria-label="Chat transcript"]')!.getBoundingClientRect();
      return box.height > 0 && box.top >= view.top && box.bottom <= view.bottom;
    });
  const expandedIds = (page: Page) =>
    page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.expanded);

  test("Find's unfold of folded code in a row scrolled away is transient", async ({ page }) => {
    await openLong(page, 200);
    // All history is retained; answer 101 is far above the viewport, so not mounted.
    await scrollToStart(page);
    await scrollToEnd(page);
    await settle(page);
    await wheelUp(page, 1500);
    const row = page.locator('[data-transcript-row="entry:long-101"]');
    await expect(row).toHaveCount(0);
    const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    // Only answer 101's folded lines hold this.
    await find.fill('line59 = 101;');
    await expect(row.getByRole('button', { name: 'Fold code' })).toBeAttached();
    await expect.poll(() => isActiveMatchInView(page)).toBe(true);
    await settle(page);
    expect(await expandedIds(page)).toEqual([]);
    // Once Find is closed and the row unmounts, the code folds again.
    await find.press('Escape');
    await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
    await scrollToEnd(page);
    await expect(row).toHaveCount(0);
    await showRow(page, 'entry:long-101');
    await expect(row.getByRole('button', { name: /^Show all/ })).toBeVisible();
  });

  test("Find's unfold of folded code in a mounted row off-screen keeps the match's anchor", async ({
    page,
  }) => {
    await page.goto('/?local&design&transcript');
    await page.getByRole('button', { name: /^Conversation/ }).click();
    await expect(transcriptList(page)).toBeVisible();
    await page.evaluate(async () => {
      const code = Array.from({ length: 60 }, (_, index) =>
        index === 2 || index === 49 ? `const needle = ${index};` : `line ${index}`,
      ).join('\n');
      await window.demo.transcript!.record([
        {
          id: 'code',
          parts: [{ text: 'Intro.\n\n```\n' + code + '\n```\n', kind: 'text', role: 'assistant' }],
        },
        ...Array.from({ length: 30 }, (_, index) => ({
          id: `filler-${index}`,
          parts: [
            {
              text: 'A paragraph of steady explanation. '.repeat(40),
              kind: 'text' as const,
              role: 'assistant' as const,
            },
          ],
        })),
      ]);
    });
    const row = page.locator('[data-transcript-row="entry:code"]');
    const find = await findText(page, 'needle');
    // The first match is in the shown lines.
    await expect.poll(() => isActiveMatchInView(page)).toBe(true);
    await expect(row.getByRole('button', { name: /^Show all/ })).toBeVisible();
    // The reader scrolls away (over prose, not the code's own scroller); the active match's row
    // stays mounted.
    const box = (await transcriptList(page).boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height - 80);
    for (let step = 0; step < 4; step++) await page.mouse.wheel(0, 600);
    await settle(page);
    await expect(row).toBeAttached();
    expect(await row.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThan(
      await transcriptList(page).evaluate((node) => node.getBoundingClientRect().top),
    );
    await recordAnchors(page);
    // The next match is in the folded lines.
    await find.focus();
    await find.press('Enter');
    await expect(row.getByRole('button', { name: 'Fold code' })).toBeVisible();
    await expect.poll(() => isActiveMatchInView(page)).toBe(true);
    await settle(page);
    // Only anchors in the match's row are saved: the unfold saves no position away from it.
    const saved = await readSavedAnchors(page);
    expect(saved.length).toBeGreaterThan(0);
    for (const anchor of saved)
      expect(anchor).toEqual(expect.objectContaining({ key: 'entry:code' }));
    expect(await expandedIds(page)).toEqual([]);
  });

  test('an unfolded code block stays unfolded after scrolling away and back', async ({ page }) => {
    await openLong(page, 200);
    const row = page.locator('[data-transcript-row="entry:long-191"]');
    await showRow(page, 'entry:long-191');
    await row.getByRole('button', { name: /^Show all/ }).click();
    await expect(row.getByRole('button', { name: 'Fold code' })).toBeVisible();
    // The focused row stays mounted; reading elsewhere releases it.
    await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
    await scrollToStart(page);
    await expect(row).toHaveCount(0);
    await scrollToEnd(page);
    await showRow(page, 'entry:long-191');
    await expect(row.getByRole('button', { name: 'Fold code' })).toBeVisible();
    await expect(row.getByText('const line59 = 191;')).toBeAttached();
  });

  test('closing Find returns focus where it was, or to the transcript once that row unmounted', async ({
    page,
  }) => {
    // Every answer has a table, so the tables share one label; two far-apart answers match.
    await page.goto('/?local&design&transcript');
    await page.evaluate(async () => {
      await window.demo.transcript!.record(
        Array.from({ length: 400 }, (_, index) => ({
          id: `table-${index}`,
          parts: [
            {
              kind: 'text' as const,
              text:
                `Answer ${index}${[5, 398].includes(index) ? ' with a needle' : ''}.\n\n` +
                `| Column | Value |\n| --- | --- |\n| row | ${index} |\n`,
            },
          ],
        })),
      );
    });
    await page.getByRole('button', { name: /^Conversation/ }).click();
    const table = (index: number) =>
      page.locator(`[data-transcript-row="entry:table-${index}"]`).getByRole('region', {
        name: 'Table',
        exact: true,
      });
    const focusedRow = () =>
      page.evaluate(
        () =>
          document.activeElement?.closest<HTMLElement>('[data-transcript-row]')?.dataset
            .transcriptRow ?? document.activeElement?.getAttribute('aria-label'),
      );
    const field = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    const highlighted = (entry: string) =>
      expect
        .poll(() => readFindHighlight(page))
        .toEqual([expect.objectContaining({ entry, visible: true })]);

    // A focused element that stayed mounted gets focus back.
    await table(398).focus();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(field).toBeFocused();
    await field.press('Escape');
    await expect(table(398)).toBeFocused();

    // A match far back unmounts the focused row, which leaves focus on the transcript.
    await table(399).focus();
    await page.keyboard.press('ControlOrMeta+f');
    await field.fill('needle');
    await expect(findStatus(page, /2 matches/)).toBeVisible();
    await field.press('Shift+Enter');
    await highlighted('table-5');
    await expect(page.locator('[data-transcript-row="entry:table-399"]')).toHaveCount(0);
    await field.press('Escape');
    await expect(transcriptList(page)).toBeFocused();
    expect(await focusedRow()).toBe('Chat transcript');
  });

  test('a failed view restore shows its error and Retry above the list', async ({ page }) => {
    await openLong(page, 400);
    await page.evaluate(() => window.demo.application.chat!.jumpToEntry('long-100'));
    const row = page.locator('[data-transcript-row="entry:long-100"]');
    await expect(row).toBeVisible();
    // The reader was 40px into the row.
    const anchor = { key: 'entry:long-100', offset: 40 };
    await page.evaluate(
      (anchor) => window.demo.application.chat!.setTranscriptView({ anchor, expanded: [] }),
      anchor,
    );
    await page.getByRole('button', { name: 'Close Chat panel', exact: true }).locator('..').hover();
    await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await page.evaluate(() => {
      const client = window.demo.chat.dependencies.chat,
        original = client.command;
      let failed = false;
      client.command = async (operation, input, options) => {
        if (operation === 'getChatHistoryAround' && !failed) {
          failed = true;
          throw Error('Controlled restore failure');
        }
        return original(operation, input, options) as never;
      };
    });
    await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Retry history' });
    await expect(alert).toBeInViewport();
    // Outside the list, so scrolling and virtualization never take it away.
    await expect(transcriptList(page).getByRole('alert')).toHaveCount(0);
    await alert.getByRole('button', { name: 'Retry history', exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(row).toBeVisible();
    // Retry restores the saved position, not the row's top.
    expect(await savedAnchor(page)).toEqual(anchor);
    await expect
      .poll(async () => {
        const [box, list] = await Promise.all([
          row.boundingBox(),
          transcriptList(page).boundingBox(),
        ]);
        return Math.abs(box!.y - list!.y + 40);
      })
      .toBeLessThan(1.5);
  });

  test('a reading position inside an activity card restores though fewer of its rows are read above it', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto('/?local&design&transcript');
    await page.getByRole('button', { name: /^Conversation/ }).click();
    await expect(transcriptList(page)).toBeVisible();
    // One card of 60 calls, then answers, so the card isn't at the live edge.
    await page.evaluate(async () => {
      await window.demo.transcript!.record([
        { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
        ...Array.from({ length: 60 }, (_, index) => ({
          id: `step-${index}`,
          parts: [
            {
              kind: 'arguments' as const,
              partId: 'call',
              toolName: 'bash',
              state: 'completed' as const,
              text: JSON.stringify({ command: `step ${index}` }),
            },
          ],
        })),
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `answer-${index}`,
          parts: [{ kind: 'text' as const, text: `Answer ${index}\n\n` + 'words '.repeat(60) }],
        })),
      ]);
      const chat = window.demo.application.chat!;
      await chat.jumpToEntry('step-50');
      await chat.showEarlier();
      // With more of the card retained, place its row at the top again.
      await chat.jumpToEntry('step-50');
    });
    const row = page.locator('[data-transcript-row="entry:step-50"]');
    await expect(row).toBeVisible();
    const card = () =>
      page.evaluate(() =>
        window.demo.application
          .chat!.getSnapshot()
          .transcript.entries.filter((entry) => entry.id.startsWith('step-'))
          .findIndex((entry) => entry.id === 'step-50'),
      );
    const above = await card();
    expect(above).toBeGreaterThan(30);
    // The reader scrolls a little into the call's row.
    await transcriptList(page).hover();
    await page.mouse.wheel(0, 9);
    // The jump already saved this row at offset 0; wait for the scroll's own save.
    await expect
      .poll(async () => {
        const anchor = await savedAnchor(page);
        return anchor?.key === 'entry:step-50' && (anchor.offset ?? 0) > 0;
      })
      .toBe(true);
    const { key, offset } = (await savedAnchor(page))!;
    expect(key).toBe('entry:step-50');
    expect(offset).toBeLessThan(await row.evaluate((node) => node.getBoundingClientRect().height));
    await page.getByRole('button', { name: 'Close Chat panel', exact: true }).locator('..').hover();
    await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
    await expect(row).toBeVisible();
    // The restore reads only the history around the row, so less of the card is above it.
    const restored = await card();
    expect(restored).toBeLessThan(above);
    const placed = async () => {
      const [box, list] = await Promise.all([
        row.boundingBox(),
        transcriptList(page).boundingBox(),
      ]);
      return Math.abs(box!.y - list!.y + offset);
    };
    await expect.poll(placed).toBeLessThan(1.5);
    // An earlier page that lands later joins rows to the card's start; the row stays put.
    await page.evaluate(async () => {
      const chat = window.demo.application.chat!;
      while (chat.getSnapshot().transcript.earlier) await chat.showEarlier();
    });
    expect(await card()).toBe(50);
    await expect.poll(placed).toBeLessThan(1.5);
    expect((await savedAnchor(page))?.key).toBe('entry:step-50');
  });
});

test("the image viewer's row stays mounted while the transcript scrolls", async ({ page }) => {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(transcriptList(page)).toBeVisible();
  await page.evaluate(async (data) => {
    await window.demo.transcript!.record([
      {
        id: 'image-row',
        role: 'tool',
        parts: [
          { kind: 'image', text: '', data, mimeType: 'image/png', partId: 'image', role: 'tool' },
        ],
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `after-${index}`,
        parts: [{ kind: 'text' as const, text: `Later answer ${index}\n\n` + 'words '.repeat(80) }],
      })),
    ]);
    await window.demo.application.chat!.jumpToLatest();
  }, imagePng);
  await scrollToStart(page);
  const row = page.locator('[data-transcript-row="entry:image-row"]');
  // The image shows once its card is open; it has no fold of its own.
  await openActivity(row);
  const trigger = row.getByRole('button', { name: 'View stored image' });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
  await expect(dialog).toBeVisible();
  // The modal viewer makes the rest of the page inert, so the list is found by its label.
  const list = page.locator('[aria-label="Chat transcript"]');
  await list.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await expect
    .poll(() => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(30);
  await expect(page.locator('[data-transcript-row="entry:after-39"]')).toBeAttached();
  await expect(row).toBeAttached();
  await dialog.getByRole('button', { name: 'Close image viewer' }).click();
  await expect(trigger).toBeFocused();
});

for (const [name, source, count, body] of [
  [
    'unclosed indented literal',
    '- item\n\n      ```js\n      literal\n\n  ```js\r\n  actual 🌔\t  \r\n  ```\r\n',
    2,
    'actual 🌔\t  \r\n',
  ],
  ['tabbed list continuation', '- item\n\n\t```js\r\n\t🌔 é\t  \r\n\t```\r\n', 1, '🌔 é\t  \r\n'],
  ['tabbed quote', '>\t```js\r\n>\t🌔 é\t  \r\n>\t```\r\n', 1, '🌔 é\t  \r\n'],
] as const)
  test(`R2 code Copy uses the correct parser block: ${name}`, async ({ page }) => {
    await open(page);
    await page.evaluate((source) => window.demo.transcript!.live(source), source);
    const live = page.locator('[data-transcript-live]');
    await expect(live.locator('pre')).toHaveCount(count);
    await expect(live.locator('pre').last()).toContainText(
      name.startsWith('unclosed') ? 'actual 🌔' : '🌔 é',
    );
    await expect(live.getByRole('button', { name: 'Copy code', exact: true })).toHaveCount(1, {
      timeout: 1000,
    });
    await live.getByRole('button', { name: 'Copy code', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
      .toBe(body.replace(/\r\n$/, ''));
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `r2-${name.replaceAll(' ', '-')}.png`) });
  });
test('latest snapshot recovery diagnostics survive running metadata and pinned old live DOM', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.live('```text\nRetain this selected source\n```\n'),
  );
  const live = page.locator('[data-transcript-live]');
  for (const message of [
    'Parked task requires recovery',
    'Send intent retained for recovery',
    'Submission failed',
    'Working folder is unavailable',
  ]) {
    await page.evaluate((message) => {
      window.demo.chat.snapshot.state = 'failed';
      window.demo.chat.snapshot.message = message;
      window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
    }, message);
    await expect(page.getByRole('alert', { name: 'Conversation status' })).toHaveText(
      'Failed · ' + message,
    );
    await expect(live.locator(':scope > div').first()).not.toContainText('running');
  }
  await live.locator('pre').focus();
  await live.locator('pre').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.evaluate(() => {
    window.demo.chat.snapshot.run = null;
    window.demo.chat.snapshot.state = 'uncertain';
    window.demo.chat.snapshot.message = 'Current receipt needs recovery';
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(page.getByText(/The response changed. Your selection is retained/)).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Conversation status' })).toHaveText(
    'Uncertain · Current receipt needs recovery',
  );
  await expect(live.locator('pre')).toContainText('Retain this selected source');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'r1-current-status.png') });
});

test('safe GFM, literal user content, progressive source, exact native callbacks and normal/compact/200% reading', async ({
  page,
}) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.com')) requests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  const row = answer(page);
  await expect(page.locator('[data-transcript-entry="reading-178"] code')).toHaveCount(0);
  await expect(page.locator('[data-transcript-entry="reading-178"] pre')).toContainText(
    '```typescript',
  );
  // The authored table; the open card's recorded patch draws its own.
  const authored = row.locator('table:not([data-transcript-activity] table)');
  await expect(authored).toHaveCount(1);
  await expect(authored.locator('th').last()).toHaveCSS('text-align', 'right');
  await expect(authored.locator('tbody tr').first().locator('td').last()).toHaveCSS(
    'text-align',
    'right',
  );
  await expect(row.locator('blockquote')).toHaveCount(1);
  // Authored lists only; the activity card's step list is not part of the answer.
  await expect(row.locator('ul:not([data-transcript-activity] > ul)')).toHaveCount(2);
  // No markup from the source runs or renders; the row's own controls draw icons.
  await expect(
    row.locator('script, svg:not(button svg), img, style, iframe, button[onclick]'),
  ).toHaveCount(0);
  await expect(
    row.getByText('<button onclick="alert(1)">inert model control</button>', { exact: false }),
  ).toBeAttached();
  await row.getByRole('link', { name: 'Read documentation' }).click();
  await row.getByRole('link', { name: 'Read documentation' }).click({ button: 'middle' });
  expect(await page.evaluate(() => window.demo.transcript!.links)).toEqual([
    'https://example.com/read',
    'https://example.com/read',
  ]);
  await expect(row.locator('a a')).toHaveCount(0);
  await row.getByRole('link', { name: 'Badge target', exact: true }).click();
  await row.getByRole('link', { name: 'Image: Badge target', exact: true }).click();
  expect(await page.evaluate(() => window.demo.transcript!.links.slice(-2))).toEqual([
    'https://example.com/badge',
    'https://example.com/never-fetch-badge.png',
  ]);
  await row.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('  const moon = "🌔";\t\r\nconsole.log(moon);');
  // open() opened this row's card, so its output shows with no fold of its own.
  await expect(row.getByText(/Read more/)).toBeVisible();
  await row.getByRole('button', { name: 'Copy part', exact: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)?.length))
    .toBeGreaterThan(90000);
  await row.getByRole('button', { name: 'Load more parts' }).click();
  // Redacted thinking is a step whose line says so.
  await expect(
    row.locator('[data-transcript-step] > [data-glyph]', { hasText: 'Thought redacted' }),
  ).toBeVisible();
  await expect(row.getByRole('button', { name: 'Load more parts' })).toHaveCount(0);
  await row.getByRole('button', { name: /Notice.*unsupported/ }).click();
  await expect(
    row.getByText('Published unknown record description', { exact: true }),
  ).toBeVisible();
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await row.getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'normal.png') });
  await page.setViewportSize({ width: 640, height: 700 });
  await expect
    .poll(() =>
      page
        .getByRole('main', { name: 'Agent workspace', exact: true })
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    // The window less the 52px project rail and the panel's 1px edge.
    .toBe(587);
  await page.setViewportSize({ width: 540, height: 844 });
  await row.getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'compact.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 720, height: 450 });
  await page.screenshot({ path: resolve(output, 'zoom-200.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});
test('disconnect cancels a held native action visibly and a late settlement cannot become success', async ({
  page,
}) => {
  await page.goto('/?chat&design&transcript');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(answer(page).getByRole('heading')).toBeAttached();
  await page.evaluate(() => {
    window.demo.transcript!.native.copy = (_input, signal) =>
      new Promise<void>((resolve) => {
        signal!.addEventListener('abort', () => setTimeout(resolve, 50), { once: true });
      });
  });
  await answer(page).getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect(page.getByText('Copying complete source…', { exact: true })).toBeVisible();
  await disconnectChat(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Native action cancelled' }),
  ).toBeVisible();
  await expect(page.getByText('Copied.', { exact: true })).toHaveCount(0);
});
test('a late definition replaces a selected split message with the complete document', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.demo.transcript!.live('Intro [Read][ref]\n\nLater text\n'));
  const live = page.getByRole('article', { name: 'Live response' });
  await expect(live.getByText('Later text', { exact: true })).toBeVisible();
  await live
    .locator('p')
    .first()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
  await page.evaluate(() =>
    window.demo.transcript!.live(
      'Intro [Read][ref]\n\nLater text\n\n[ref]: https://example.com/reference\n',
    ),
  );
  await expect(live.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  await expect(live.getByText('Later text', { exact: true })).toBeVisible();
});

test('incomplete/unknown/oversized code remains readable and copyable; late references re-render their message', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.live('[Read][ref]\n\n```unknown\n🌔 incomplete'),
  );
  const live = page.getByRole('article', { name: 'Live response' });
  await expect(live.getByText('unknown · Incomplete', { exact: true })).toBeVisible();
  await expect(live.getByRole('link')).toHaveCount(0);
  const before = await page.evaluate(() => ({ ...window.demo.transcript!.metrics }));
  await page.evaluate(() =>
    window.demo.transcript!.live(
      '[Read][ref]\n\n```unknown\n🌔 incomplete\n```\n\n[ref]: https://example.com/reference\n',
    ),
  );
  await expect(live.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  await expect(live.getByText('unknown', { exact: true })).toBeVisible();
  expect(
    (await page.evaluate(() => window.demo.transcript!.metrics.tokenize)) - before.tokenize,
  ).toBe(0);
  await page.evaluate(() =>
    window.demo.transcript!.live('```typescript\n' + 'const value = 1;\n'.repeat(18000) + '```\n'),
  );
  await page.evaluate(async () => {
    const controller = window.demo.application.chat!;
    const summary = controller.getSnapshot().snapshot!.run!.transcript!,
      part = summary.parts[0]!;
    for (let i = 0; i < 24; i++) {
      await controller.loadTranscriptPart(summary.source, {
        partId: part.partId,
        bytes: part.bytes,
        revision: part.revision,
      });
      if (
        controller
          .getSnapshot()
          .transcript.content.find((content) => content.selection.revision === part.revision)
          ?.status === 'complete'
      )
        break;
    }
  });
  await expect(live.getByRole('button', { name: /Show all 18000 lines/ })).toBeVisible();
  const unchanged = await page.evaluate(async () => {
    const before = window.demo.transcript!.metrics.lex;
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return { before, after: window.demo.transcript!.metrics.lex };
  });
  expect(unchanged.after).toBe(unchanged.before);
  await live.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('const value = 1;\n'.repeat(17999) + 'const value = 1;');
  await live.getByRole('button', { name: /Show all 18000 lines/ }).click();
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeVisible();
  await live.locator('pre code').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  expect(
    await live.locator('pre').evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  // Unhighlighted: the shown lines and the unfolded lines' panel (Find source spans) hold plain
  // text, with no line or token spans.
  await expect(live.locator('pre code span:not([id], [data-find-source])')).toHaveCount(0);
  await page.evaluate(() =>
    window.demo.transcript!.live(
      'Replacement with &amp; and &#x1f314; <img src="https://example.com/no-fetch" onerror="alert(1)">',
    ),
  );
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeFocused();
  // Focus holds the block being read; reading elsewhere shows the replacement.
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await expect(live.getByText(/Replacement with & and 🌔/)).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
  await expect(live.locator('img')).toHaveCount(0);
});

test('Retry repeats a failed earlier read', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const client = window.demo.chat.dependencies.chat,
      original = client.command;
    let failed = false;
    client.command = async (operation, input, options) => {
      if (operation === 'getChatHistoryAround') {
        window.demo.chat.calls.push('navigation:' + JSON.stringify(input));
        if (!failed) {
          failed = true;
          throw Error('Controlled history read failure');
        }
      }
      return original(operation, input, options) as never;
    };
  });
  const alert = page.getByRole('alert').filter({ hasText: 'Retry history' }),
    retry = alert.getByRole('button', { name: 'Retry history', exact: true });
  await transcriptList(page).hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -100000);
      return retry.isVisible();
    })
    .toBe(true);
  // History errors show above the list, out of reach of scrolling and virtualization.
  await expect(alert).toBeInViewport();
  await retry.click();
  await expect(retry).toHaveCount(0);
  const reads = await page.evaluate(() =>
    window.demo.chat.calls.filter((call) => call.startsWith('navigation:')),
  );
  expect(reads).toHaveLength(2);
  expect(reads[1]).toBe(reads[0]);
});

test('retired live DOM stays pinned for focus and selection until Jump to latest', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.live('```typescript\nconst selected = "held source";\n```\n'),
  );
  const live = page.locator('[data-transcript-live]'),
    code = live.locator('pre');
  await code.focus();
  const selected = await code.evaluate((element) => {
    element.setAttribute('data-retained-selection', 'true');
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  await page.waitForTimeout(25);
  await page.evaluate(() => {
    window.demo.chat.snapshot.run = null;
    window.demo.chat.snapshot.state = 'idle';
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(page.getByText(/The response changed. Your selection is retained/)).toBeVisible();
  await expect(page.locator('[data-retained-selection]')).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.locator('[data-retained-selection]')).toHaveCount(0);
});

test('partial Markdown cannot copy a different complete-source code node', async ({ page }) => {
  await open(page);
  const prefix = 'x'.repeat(15993) + '\n\n```js';
  // Past the live budget, so the reply is read in chunks rather than carried whole.
  await page.evaluate(
    (text) => window.demo.transcript!.live(text),
    prefix + '`invalid\n\n```python\nWRONG BLOCK\n```\n\n' + 'y'.repeat(64 * 1024),
  );
  const live = page.locator('[data-transcript-live]');
  await expect(live.locator('pre')).toHaveText('');
  await live.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'displayed code block changed' }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.demo.transcript!.copied)).toEqual([]);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'r4-reinterpreted-code.png') });
  await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toHaveCount(0);
  await live.getByRole('button', { name: /^Read more/ }).click();
  await expect(live.locator('pre')).toHaveText('WRONG BLOCK');
  await live.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('WRONG BLOCK');
});

test('Find reveals unloaded folded manifest parts and exact Unicode source while keeping field focus', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(
      0,
      [
        'ordinary',
        'other',
        'third',
        'fourth',
        'fifth',
        'sixth',
        'x'.repeat(70000) + '😀 Σneedle [.*]\r\n',
      ],
      ['text', 'text', 'text', 'text', 'text', 'text', 'thinking'],
    );
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await expect(find).toBeFocused();
  await find.fill('σNEEDLE [.*]');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      {
        text: 'Σneedle [.*]',
        entry: 'reading-0',
        part: 'm0.b6',
        before: 'xxxxxxxxxxxxx😀 ',
        visible: true,
      },
    ]);
  await expect(find).toBeFocused();
  const row = page.locator('[data-transcript-entry="reading-0"]');
  await expect(row.getByRole('region', { name: 'Matched original source' })).toHaveCount(0);
  // The thinking's card is open; parts inside a card have no fold of their own.
  await expect(row.getByRole('button', { name: /^Activity/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const active = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.find.active,
  );
  expect(active?.start).toBe(70003);
  await page.screenshot({ path: resolve('../../test-results/find-114/unloaded.png') });
  await find.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(transcript(page)).toBeFocused();
});

test('Find next/previous reports completion and leaves composer shortcuts scoped', async ({
  page,
}) => {
  await open(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.focus();
  await page.keyboard.press('Control+f');
  await expect(
    page.getByRole('textbox', { name: 'Find in conversation', exact: true }),
  ).toHaveCount(0);
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('Saved answer');
  await expect(page.getByRole('status').filter({ hasText: /1 of 179 matches/ })).toBeVisible();
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      expect.objectContaining({ text: 'Saved answer', entry: 'reading-0', visible: true }),
    ]);
  await find.press('Enter');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      expect.objectContaining({ text: 'Saved answer', entry: 'reading-1', visible: true }),
    ]);
  await expect(page.getByRole('status').filter({ hasText: /2 of 179 matches/ })).toBeVisible();
  await find.press('Shift+Enter');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      expect.objectContaining({ text: 'Saved answer', entry: 'reading-0', visible: true }),
    ]);
  await expect(page.getByRole('status').filter({ hasText: /1 of 179 matches/ })).toBeVisible();
  await expect(page.locator('[data-transcript-find-match]')).toHaveCount(0);
  await expect(find).toBeFocused();
  await find.fill('nothing in this saved conversation');
  await expect(
    page.getByRole('status').filter({ hasText: 'No matches in the saved conversation.' }),
  ).toBeVisible();
  await find.press('Escape');
});

test('Find paints prose matches in the rendered message and clears them on close', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, [
      'First **Needle** one, needle two.\n\nLast NEEDLE.',
    ]);
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  await expect(page.getByRole('status').filter({ hasText: /1 of 3 matches/ })).toBeVisible();
  const painted = async () => ({
    active: (await readFindHighlight(page)).map((range) => range.text + '@' + range.before),
    matches: (await readFindHighlight(page, 'find-match')).map((range) => range.text).sort(),
  });
  await expect.poll(painted).toEqual({ active: ['Needle@'], matches: ['NEEDLE', 'needle'] });
  await find.press('Enter');
  await expect.poll(painted).toEqual({ active: ['needle@ one, '], matches: ['NEEDLE', 'Needle'] });
  await expect(page.getByRole('status').filter({ hasText: /2 of 3 matches/ })).toBeVisible();
  await find.press('Enter');
  await expect.poll(painted).toEqual({ active: ['NEEDLE@Last '], matches: ['Needle', 'needle'] });
  await find.press('Shift+Enter');
  await expect.poll(painted).toEqual({ active: ['needle@ one, '], matches: ['NEEDLE', 'Needle'] });
  const row = page.locator('[data-transcript-entry="reading-0"]');
  await expect(row.getByRole('region', { name: 'Matched original source' })).toHaveCount(0);
  await expect(row.locator('[data-transcript-part] strong')).toHaveText('Needle');
  // Replacing the painted text node detaches its range; the part's observer repaints it.
  await page.evaluate(() => {
    const node = [...(CSS.highlights.get('find-active') ?? [])][0]!.startContainer as Text;
    node.replaceWith(node.data);
  });
  await expect.poll(painted).toEqual({ active: ['needle@ one, '], matches: ['NEEDLE', 'Needle'] });
  await find.press('Escape');
  await expect(find).toHaveCount(0);
  await expect.poll(painted).toEqual({ active: [], matches: [] });
  expect(
    await page.evaluate(() => [
      CSS.highlights.has('find-active'),
      CSS.highlights.has('find-match'),
    ]),
  ).toEqual([false, false]);
});

test('Find shows the original-source excerpt for a match inside a link URL', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, ['See [docs](https://example.com/needle) here.']);
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  const excerpt = page
    .locator('[data-transcript-entry="reading-0"]')
    .getByRole('region', { name: 'Matched original source' });
  await expect(excerpt).toContainText('See [docs](https://example.com/needle) here.');
  await expect(excerpt.locator('[data-transcript-find-match]')).toHaveText('needle');
  await expect(excerpt.locator('[data-transcript-find-match]')).toBeInViewport();
  expect(await readFindHighlight(page)).toEqual([]);
  await expect(find).toBeFocused();
  await find.press('Escape');
  await expect(excerpt).toHaveCount(0);
});

/** Opens Find from the transcript and searches for `query`. */
async function findText(page: Page, query: string) {
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill(query);
  return find;
}
const findOpen = (page: Page) =>
  page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.find.open);
const findStatus = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text });
const originalExcerpt = (page: Page) =>
  page
    .locator('[data-transcript-entry="reading-0"]')
    .getByRole('region', { name: 'Matched original source' });

test('Enter on a Find bar button presses that button; only the field steps through matches', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, ['needle one, needle two, needle three.']);
  });
  const find = await findText(page, 'needle');
  const bar = page.getByRole('region', { name: 'Find in conversation', exact: true });
  await expect(findStatus(page, /1 of 3 matches/)).toBeVisible();
  await find.press('Enter');
  await expect(findStatus(page, /2 of 3 matches/)).toBeVisible();
  await bar.getByRole('button', { name: 'Previous', exact: true }).press('Enter');
  await expect(findStatus(page, /1 of 3 matches/)).toBeVisible();
  await bar.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await expect(findStatus(page, /2 of 3 matches/)).toBeVisible();
  // New history while results are open offers a refresh rather than reshuffling them.
  await page.evaluate(() =>
    window.demo.transcript!.record([
      { id: 'refreshed', parts: [{ kind: 'text', role: 'assistant', text: 'needle and needle' }] },
    ]),
  );
  const refresh = bar.getByRole('button', { name: 'Refresh results', exact: true });
  await expect(findStatus(page, /2 of 3 matches/)).toBeVisible();
  await refresh.press('Enter');
  await expect(findStatus(page, /1 of 2 matches/)).toBeVisible();
  await expect(refresh).toHaveCount(0);
  await bar.getByRole('button', { name: 'Close Find', exact: true }).press('Enter');
  await expect(bar).toHaveCount(0);
});

test('Find shortcut skips every editable host and uses the physical F key on non-Latin layouts', async ({
  page,
}) => {
  await open(page);
  for (const value of ['', 'true', 'plaintext-only']) {
    await page
      .getByRole('main', { name: 'Agent workspace', exact: true })
      .evaluate((owner, value) => {
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', value);
        editable.setAttribute('data-test-editable', '');
        editable.textContent = 'Editable';
        owner.append(editable);
        editable.focus();
      }, value);
    await page.keyboard.press('Control+f');
    expect(await findOpen(page), `contenteditable="${value}"`).toBe(false);
    await page.locator('[data-test-editable]').evaluate((node) => node.remove());
  }
  await transcript(page).focus();
  // On a Latin layout the physical F key typed another letter, so it is not Find.
  await transcript(page).dispatchEvent('keydown', { key: 'u', code: 'KeyF', ctrlKey: true });
  expect(await findOpen(page)).toBe(false);
  await transcript(page).dispatchEvent('keydown', { key: 'а', code: 'KeyF', metaKey: true });
  await expect(
    page.getByRole('textbox', { name: 'Find in conversation', exact: true }),
  ).toBeFocused();
});

test('Find highlights shown code lines in place and unfolds only for a match in folded lines', async ({
  page,
}) => {
  await open(page);
  const lines = Array.from({ length: 60 }, (_, index) =>
    index === 2 || index === 49 ? `const needle = ${index};` : `line ${index}`,
  );
  await page.evaluate(async (code) => {
    await window.demo.transcript!.setEntry(0, ['Intro.\n\n```\n' + code + '\n```\n']);
  }, lines.join('\n'));
  const find = await findText(page, 'needle');
  const active = (before: RegExp) => [
    {
      text: 'needle',
      entry: 'reading-0',
      part: 'm0.b0',
      before: expect.stringMatching(before),
      visible: true,
    },
  ];
  const row = page.locator('[data-transcript-entry="reading-0"]');
  // A match in the shown lines maps although the folded lines are not rendered.
  await expect.poll(() => readFindHighlight(page)).toEqual(active(/line 1\nconst $/));
  await expect(row.getByRole('button', { name: 'Show all 60 lines', exact: true })).toBeVisible();
  await expect(originalExcerpt(page)).toHaveCount(0);
  await find.press('Enter');
  await expect.poll(() => readFindHighlight(page)).toEqual(active(/line 48\nconst $/));
  const fold = row.getByRole('button', { name: 'Fold code', exact: true });
  await expect(fold).toBeVisible();
  await expect(originalExcerpt(page)).toHaveCount(0);
  // The reader can fold it again without the view moving: no excerpt replaces what they hid.
  await fold.scrollIntoViewIfNeeded();
  await settle(page);
  const top = await transcript(page).evaluate((element) => element.scrollTop);
  await fold.click();
  await expect(row.getByRole('button', { name: 'Show all 60 lines', exact: true })).toBeVisible();
  await settle(page);
  await expect(originalExcerpt(page)).toHaveCount(0);
  const after = await transcript(page).evaluate((element) => element.scrollTop);
  expect(Math.abs(after - top)).toBeLessThan(4);
});

test('Find turns a paged patch fallback to the page holding the active match', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(
      0,
      ['Patch below.', 'x'.repeat(20000) + ' needle ' + 'y'.repeat(100)],
      ['text', 'patch'],
    );
  });
  await findText(page, 'needle');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      {
        text: 'needle',
        entry: 'reading-0',
        part: 'm0.b1',
        before: 'xxxxxxxxxxxxxxx ',
        visible: true,
      },
    ]);
  const row = page.locator('[data-transcript-entry="reading-0"]');
  await expect(row.getByText(/^Source 16,000–20,108 of 20,108 characters/)).toBeVisible();
  await expect(originalExcerpt(page)).toHaveCount(0);
});

test('Find skips rendered chrome: image labels, code language labels and patch headings', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(
      0,
      [
        'See image: here ![pic](https://example.com/p.png)\n\n```\nplain words\n```\n',
        '--- a/gone.ts\n+++ b/gone.ts\n@@ -1 +1 @@\n-gone source\n+kept source\n',
      ],
      ['text', 'patch'],
    );
  });
  const find = await findText(page, 'image:');
  const active = async () =>
    (await readFindHighlight(page)).map(({ text, part, before, visible }) => ({
      text,
      part,
      before,
      visible,
    }));
  await expect
    .poll(active)
    .toEqual([{ text: 'image:', part: 'm0.b0', before: 'See ', visible: true }]);
  await find.fill('plain');
  await expect.poll(active).toEqual([{ text: 'plain', part: 'm0.b0', before: '', visible: true }]);
  await expect(originalExcerpt(page)).toHaveCount(0);
  await find.fill('source');
  await expect
    .poll(active)
    .toEqual([{ text: 'source', part: 'm0.b1', before: '-gone ', visible: true }]);
  await expect(originalExcerpt(page)).toHaveCount(0);
  // A file name match is not rendered as source, so it shows the excerpt; the matching patch line
  // is highlighted in place.
  await find.fill('gone');
  await expect(findStatus(page, /1 of 3 matches/)).toBeVisible();
  await expect(originalExcerpt(page)).toContainText('--- a/gone.ts');
  await find.press('Enter');
  await find.press('Enter');
  await expect(findStatus(page, /3 of 3 matches/)).toBeVisible();
  await expect.poll(active).toEqual([{ text: 'gone', part: 'm0.b1', before: '-', visible: true }]);
  await expect(originalExcerpt(page)).toHaveCount(0);
});

test('Find never pairs an unrendered source match with other rendered text', async ({ page }) => {
  await open(page);
  // The bold split and the relative link's shown URL both read "zqx.ts"; only the URL is source.
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, ['Edit **zq**x.ts, see [file](./src/zqx.ts)']);
  });
  const find = await findText(page, 'zqx.ts');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([
      { text: 'zqx.ts', entry: 'reading-0', part: 'm0.b0', before: './src/', visible: true },
    ]);
  await expect(originalExcerpt(page)).toHaveCount(0);
  await find.press('Escape');
  // The match is inside an entity; the decoded "quot" is other text, so the excerpt shows.
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, ['A &quot; and quo&#116; end']);
  });
  await findText(page, 'quot');
  await expect(originalExcerpt(page)).toContainText('A &quot; and quo&#116; end');
  expect(await readFindHighlight(page)).toEqual([]);
});

test('Find maps footnote matches to their own text although footnotes render last', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(0, [
      'Body needle[^n].\n\n[^n]: Footnote needle.\n\nTail needle.',
    ]);
  });
  const find = await findText(page, 'needle');
  const painted = async () => ({
    active: (await readFindHighlight(page)).map((range) => range.before),
    matches: (await readFindHighlight(page, 'find-match')).map((range) => range.before).sort(),
  });
  await expect.poll(painted).toEqual({ active: ['Body '], matches: ['Footnote ', 'Tail '] });
  await find.press('Enter');
  await expect.poll(painted).toEqual({ active: ['Footnote '], matches: ['Body ', 'Tail '] });
  await find.press('Enter');
  await expect.poll(painted).toEqual({ active: ['Tail '], matches: ['Body ', 'Footnote '] });
  await expect(originalExcerpt(page)).toHaveCount(0);
});

test('Find highlights original text beyond the 8MiB cache and rereads evicted prefixes without changing query authority', async ({
  page,
}) => {
  test.setTimeout(120000);
  await open(page);
  const expected = await page.evaluate(async () => {
    const text = 'early NEEDLE 😀\r\n' + '😀α'.repeat(1600000) + 'late ΣNEEDLE 😀\r\n';
    await window.demo.transcript!.setEntry(0, [text], ['thinking']);
    return { start: text.indexOf('ΣNEEDLE'), end: text.indexOf('ΣNEEDLE') + 'ΣNEEDLE'.length };
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  await expect(page.getByRole('status').filter({ hasText: /1 of 2 matches/ })).toBeVisible();
  await find.press('Enter');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.demo.application
              .chat!.getSnapshot()
              .transcript.content.find(
                (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
              )?.loadedText ?? 0,
        ),
      { timeout: 100000 },
    )
    .toBeGreaterThanOrEqual(expected.end);
  await expect(page.locator('[data-transcript-find-match]')).toHaveText('NEEDLE');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.demo.application
              .chat!.getSnapshot()
              .transcript.content.find(
                (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
              )?.retainedFrom,
        ),
      { timeout: 100000 },
    )
    .toBeGreaterThan(0);
  await expect(page.locator('[data-transcript-find-match]')).toBeInViewport();
  const state = await page.evaluate(() => {
    const state = window.demo.application.chat!.getSnapshot().transcript;
    return {
      active: state.find.active,
      upper: state.find.upperEntryId,
      base: state.content.find(
        (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
      )?.chunks[0]?.textOffset,
      retained: state.content
        .flatMap((item) => item.chunks)
        .reduce(
          (total, chunk) => total + new TextEncoder().encode(JSON.stringify(chunk)).length,
          0,
        ),
      window: document.querySelector('[aria-label="Matched original source"] pre')?.textContent,
    };
  });
  expect(state.active?.start).toBe(expected.start + 1);
  expect(state.active?.end).toBe(expected.end);
  expect(state.base).toBeGreaterThan(0);
  expect(state.retained).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(state.window!.length).toBeLessThan(300);
  await expect(find).toBeFocused();
  await find.press('Shift+Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.demo.application
            .chat!.getSnapshot()
            .transcript.content.find(
              (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
            )?.retainedFrom,
      ),
    )
    .toBe(0);
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', before: 'early ', visible: true })]);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.find.active?.start,
      ),
    )
    .toBe(6);
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.upperEntryId,
    ),
  ).toBe(state.upper);
  await expect(find).toBeFocused();
  await find.press('Escape');
});

test('Find reading navigation cancels held reveal and editor shortcuts retain their own handler', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const client = window.demo.chat.dependencies.chat,
      original = client.command;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const controlled = window as typeof window & {
      releaseFind: () => void;
      findRevealHeld: boolean;
    };
    controlled.releaseFind = release;
    client.command = async (operation, input, options) => {
      if (operation === 'getChatHistoryAround') {
        controlled.findRevealHeld = true;
        await gate;
      }
      return original(operation, input, options);
    };
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  await page
    .getByRole('textbox', { name: 'Find in conversation', exact: true })
    .fill('Saved answer 0');
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { findRevealHeld: boolean }).findRevealHeld),
    )
    .toBe(true);
  await transcript(page).focus();
  await page.keyboard.press('PageDown');
  await page.evaluate(() => (window as typeof window & { releaseFind: () => void }).releaseFind());
  await expect
    .poll(() =>
      page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.find.revealing),
    )
    .toBe(false);
  await expect(page.locator('[data-transcript-entry="reading-0"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.active?.source.entryId,
    ),
  ).toBe('reading-0');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('textbox', { name: 'Find in conversation', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press('Control+f');
  await expect(
    page.getByRole('textbox', { name: 'Find in conversation', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).press('ControlOrMeta+p');
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toBeVisible();
});

test('Find respects explicit collapse until the active range changes in the same part', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.setEntry(
      0,
      ['first NEEDLE\n' + 'x'.repeat(300) + '\nsecond NEEDLE'],
      ['thinking'],
    );
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  // The thought's card folds; parts inside a card have no fold of their own.
  const thinking = page
    .locator('[data-transcript-entry="reading-0"]')
    .getByRole('button', { name: /^Activity/ });
  await expect(thinking).toHaveAttribute('aria-expanded', 'true');
  await thinking.click();
  await expect(thinking).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    window.demo.chat.snapshot.message = 'Status updated';
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(thinking).toHaveAttribute('aria-expanded', 'false');
  await find.focus();
  await find.press('Enter');
  await expect(thinking).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', before: 'xxxxxxxx\nsecond ' })]);
  await expect(find).toBeFocused();
});

for (const distance of ['nearby', 'far away'])
  test(`Find reveals a match the reader folded again after returning from a match ${distance}`, async ({
    page,
  }) => {
    await page.goto('/?local&design&transcript');
    await page.getByRole('button', { name: /^Conversation/ }).click();
    await expect(transcriptList(page)).toBeVisible();
    const filler = distance === 'nearby' ? 0 : 40;
    await page.evaluate(async (filler) => {
      await window.demo.transcript!.record([
        {
          id: 'folded',
          thinking: 'available',
          parts: [
            { text: 'Thinking about the NEEDLE', kind: 'thinking' },
            { text: 'Answer with the thought folded.', kind: 'text', role: 'assistant' },
          ],
        },
        ...Array.from({ length: filler }, (_, index) => ({
          id: `filler-${index}`,
          parts: [
            {
              text: 'A paragraph of steady explanation. '.repeat(40),
              kind: 'text' as const,
              role: 'assistant' as const,
            },
          ],
        })),
        {
          id: 'plain',
          parts: [{ text: 'The plain NEEDLE.', kind: 'text', role: 'assistant' }],
        },
      ]);
    }, filler);
    const find = await findText(page, 'needle');
    const activeEntry = () =>
      page.evaluate(
        () =>
          window.demo.application.chat!.getSnapshot().transcript.find.active?.source.entryId ??
          null,
      );
    const step = async (key: 'Enter' | 'Shift+Enter', entry: string) => {
      await find.focus();
      await find.press(key);
      await expect.poll(activeEntry).toBe(entry);
    };
    if ((await expect.poll(activeEntry).not.toBeNull(), await activeEntry()) !== 'folded')
      await step('Enter', 'folded');
    // The thought's card folds; parts inside a card have no fold of their own.
    const thinking = page
      .locator('[data-transcript-entry="folded"]')
      .getByRole('button', { name: /^Activity/ });
    await expect(thinking).toHaveAttribute('aria-expanded', 'true');
    await thinking.click();
    await expect(thinking).toHaveAttribute('aria-expanded', 'false');
    await step('Enter', 'plain');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ entry: 'plain', visible: true })]);
    await step('Shift+Enter', 'folded');
    await expect(thinking).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'NEEDLE', entry: 'folded', visible: true })]);
  });

test('Find Previous replays an evicted part manifest without changing its query cutoff', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const texts = Array.from({ length: 1100 }, (_, index) => `thought ${index}`);
    texts[0] = 'first NEEDLE';
    texts[1099] = 'last NEEDLE';
    await window.demo.transcript!.setEntry(
      0,
      texts,
      texts.map(() => 'thinking'),
    );
  });
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', part: 'm0.b0' })]);
  const cutoff = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.find.upperEntryId,
  );
  await find.press('Enter');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', part: 'm0.b1099' })]);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.manifest?.omittedParts ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await find.press('Shift+Enter');
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', part: 'm0.b0' })]);
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.upperEntryId,
    ),
  ).toBe(cutoff);
  await expect(find).toBeFocused();
});

type FindResumeProbe = {
  held: boolean;
  reads: number;
  cursors: (string | null)[];
  signal?: AbortSignal;
  settled: boolean;
  releaseOld: () => void;
  manualSignal?: AbortSignal;
  manual?: Promise<void>;
  releaseManual: () => void;
};
for (const late of ['reply', 'error'] as const)
  test(`Find resumes a cancelled first content read for a new same-part range before its late ${late} settles`, async ({
    page,
  }) => {
    await open(page);
    const expected = await page.evaluate(async (late) => {
      const text = 'α😀'.repeat(6000) + 'first NEEDLE and second NEEDLE\r\n';
      await window.demo.transcript!.setEntry(0, [text], ['thinking']);
      const command = window.demo.chat.dependencies.chat.command;
      const old = Promise.withResolvers<void>(),
        manual = Promise.withResolvers<void>();
      const controlled = window as typeof window & { findResume: FindResumeProbe };
      const probe: FindResumeProbe = (controlled.findResume = {
        held: false,
        reads: 0,
        cursors: [],
        settled: false,
        releaseOld: () => old.resolve(),
        releaseManual: () => manual.resolve(),
      });
      window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
        const selected =
          operation === 'getChatTranscriptContent' &&
          'selection' in input &&
          input.selection?.partId === 'm0.b0' &&
          'source' in input &&
          input.source.kind === 'entry' &&
          input.source.entryId === 'reading-0';
        const count = selected ? ++probe.reads : 0;
        if (selected) probe.cursors.push('cursor' in input ? (input.cursor ?? null) : null);
        const reply = await command(operation, input, options);
        if (count === 1) {
          probe.signal = options?.signal;
          probe.held = true;
          await old.promise;
          probe.settled = true;
          if (late === 'error') throw Error('obsolete first Find content error');
        }
        if (
          operation === 'getChatHistoryAround' &&
          'entryId' in input &&
          input.entryId === 'reading-50'
        ) {
          probe.manualSignal = options?.signal;
          await manual.promise;
        }
        return reply;
      };
      return { start: text.lastIndexOf('NEEDLE'), bytes: new TextEncoder().encode(text).length };
    }, late);
    try {
      await transcript(page).focus();
      await page.keyboard.press('Control+f');
      const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
      await find.fill('needle');
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { findResume: FindResumeProbe }).findResume.held,
          ),
        )
        .toBe(true);
      const first = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.find.active,
      );
      const row = page.locator('[data-transcript-entry="reading-0"]');
      // The thought's card folds; parts inside a card have no fold of their own.
      const thinking = row.getByRole('button', { name: /^Activity/ });
      await expect(thinking).toHaveAttribute('aria-expanded', 'true');
      await thinking.click();
      await expect(thinking).toBeFocused();
      await expect(thinking).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = window.demo.application.chat!.getSnapshot().transcript;
            const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
            const content = state.content.find(
              (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
            );
            return {
              aborted: probe.signal?.aborted,
              reads: probe.reads,
              settled: probe.settled,
              revealing: state.find.revealing,
              query: state.find.query,
              active: state.find.active,
              content: content && {
                status: content.status,
                bytes: content.loadedBytes,
                cursor: content.nextCursor,
                error: content.error,
              },
            };
          }),
        )
        .toEqual({
          aborted: true,
          reads: 1,
          settled: false,
          revealing: false,
          query: 'needle',
          active: first,
          content: { status: 'partial', bytes: 0, cursor: null, error: null },
        });
      await find.press('Enter');
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as typeof window & { findResume: FindResumeProbe }).findResume.reads,
            ),
          { timeout: 2000 },
        )
        .toBeGreaterThan(1);
      await expect(thinking).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(() => readFindHighlight(page))
        .toEqual([
          expect.objectContaining({ text: 'NEEDLE', before: 'EDLE and second ', visible: true }),
        ]);
      await expect(find).toBeFocused();
      const second = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.find.active,
      );
      expect(second).toMatchObject({
        source: first!.source,
        partId: first!.partId,
        start: expected.start,
        end: expected.start + 6,
      });
      expect(second!.start).toBeGreaterThan(first!.start);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = window.demo.application.chat!.getSnapshot().transcript;
            const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
            const content = state.content.find(
              (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
            );
            return {
              status: content?.status,
              bytes: content?.loadedBytes,
              reads: probe.reads,
              firstCursors: probe.cursors.slice(0, 2),
              settled: probe.settled,
            };
          }),
        )
        .toEqual({
          status: 'complete',
          bytes: expected.bytes,
          reads: 4,
          firstCursors: [null, null],
          settled: false,
        });
      if (late === 'reply') {
        await mkdir(resolve('../../test-results/find-114'), { recursive: true });
        await page.screenshot({
          path: resolve('../../test-results/find-114/resume-zero-byte.png'),
        });
      }
      await page.evaluate(() => {
        const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
        probe.manual = window.demo.application.chat!.jumpToEntry('reading-50').then(() => {});
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              !!(window as typeof window & { findResume: FindResumeProbe }).findResume.manualSignal,
          ),
        )
        .toBe(true);
      await page.evaluate(() => {
        window.demo.application.chat!.cancelFindReveal();
        (window as typeof window & { findResume: FindResumeProbe }).findResume.releaseOld();
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { findResume: FindResumeProbe }).findResume.settled,
          ),
        )
        .toBe(true);
      const current = await page.evaluate(() => {
        const state = window.demo.application.chat!.getSnapshot().transcript;
        const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
        return {
          aborted: probe.manualSignal?.aborted,
          loading: state.loading,
          error: state.error,
          findError: state.find.error,
          active: state.find.active,
          query: state.find.query,
          reads: probe.reads,
          content: state.content.find(
            (item) => item.source.kind === 'entry' && item.source.entryId === 'reading-0',
          ),
        };
      });
      expect(current).toMatchObject({
        aborted: false,
        loading: true,
        error: null,
        findError: null,
        active: second,
        query: 'needle',
        reads: 4,
        content: { status: 'complete', loadedBytes: expected.bytes, error: null },
      });
      await page.evaluate(async () => {
        const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
        probe.releaseManual();
        await probe.manual;
      });
      const final = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript,
      );
      expect(final.view.anchor?.key).toBe('entry:reading-50');
      expect(final.error).toBe(null);
      expect(final.find.active).toEqual(second);
      expect(final.find.query).toBe('needle');
      expect(final.find.revealing).toBe(false);
    } finally {
      await page.evaluate(() => {
        const probe = (window as typeof window & { findResume: FindResumeProbe }).findResume;
        probe.releaseOld();
        probe.releaseManual();
      });
    }
  });

for (const activation of ['Control+f', 'Meta+f', 'Find button'])
  test(`R3 ${activation} refocuses an already-open Find bar after reading navigation`, async ({
    page,
  }) => {
    await page.goto('/?local&design&transcript');
    await page.getByRole('button', { name: /^Conversation/ }).click();
    const region = page.getByRole('region', { name: 'Chat transcript', exact: true });
    await region.focus();
    await page.keyboard.press('Control+f');
    const field = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    await expect(field).toBeFocused();
    await field.fill('Saved answer 0');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'Saved answer 0', entry: 'reading-0' })]);
    await region.focus();
    await page.keyboard.press('PageDown');
    await expect(region).toBeFocused();
    let previousTop = -1;
    await expect
      .poll(async () => {
        const top = await region.evaluate((element) => element.scrollTop);
        const settled = top > 0 && top === previousTop;
        previousTop = top;
        return settled;
      })
      .toBe(true);
    await page.evaluate(async () => {
      window.demo.chat.snapshot.message = 'Background update while reading';
      window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(region).toBeFocused();
    const before = await region.evaluate((element) => {
      const state = window.demo.application.chat!.getSnapshot().transcript.find;
      return {
        top: element.scrollTop,
        query: state.query,
        active: state.active,
        cutoff: state.upperEntryId,
        revealing: state.revealing,
      };
    });
    if (activation === 'Find button')
      await page
        .locator('header[aria-label="Window title bar"]')
        .getByRole('button', { name: 'Find', exact: true })
        .click();
    else await page.keyboard.press(activation);
    await page.screenshot({
      path: resolve(
        `../../test-results/find-114-r3/refocus-${activation.replaceAll(/[^a-z]/gi, '')}.png`,
      ),
    });
    expect(
      await page.evaluate(() => ({
        open: window.demo.application.chat!.getSnapshot().transcript.find.open,
        query: window.demo.application.chat!.getSnapshot().transcript.find.query,
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
      })),
    ).toMatchObject({ open: true, query: 'Saved answer 0' });
    await expect(field).toBeFocused();
    const after = await region.evaluate((element) => {
      const state = window.demo.application.chat!.getSnapshot().transcript.find;
      return {
        top: element.scrollTop,
        query: state.query,
        active: state.active,
        cutoff: state.upperEntryId,
        revealing: state.revealing,
      };
    });
    expect(after).toEqual(before);
    await field.press('End');
    await page.keyboard.type('x');
    await expect(field).toHaveValue('Saved answer 0x');
    await expect
      .poll(() =>
        page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.find.query),
      )
      .toBe('Saved answer 0x');
    await expect(field).toBeFocused();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.focus();
    for (const key of ['Control+f', 'Meta+f']) {
      await page.keyboard.press(key);
      await expect(composer).toBeFocused();
      await expect(field).toHaveValue('Saved answer 0x');
    }
  });
/** Counts committed renders of transcript rows by entry ID through React's DevTools hook. */
async function countRowRenders(page: Page) {
  await page.addInitScript(() => {
    type Fiber = {
      type: unknown;
      memoizedProps: { entry?: { id: string } } | null;
      child: Fiber | null;
      sibling: Fiber | null;
    };
    const seen = new WeakSet<object>();
    const renders: string[] = [];
    Object.assign(window, { rowRenders: renders });
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      value: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE() {},
        onScheduleFiberRoot() {},
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const stack: Fiber[] = [root.current];
          while (stack.length) {
            const fiber = stack.pop()!;
            const props = fiber.memoizedProps;
            // A memoized row that skips rendering keeps its previous props object.
            if (
              typeof fiber.type === 'function' &&
              fiber.type.name === 'Entry' &&
              props?.entry &&
              !seen.has(props)
            ) {
              seen.add(props);
              renders.push(props.entry.id);
            }
            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
          }
        },
      },
    });
  });
  return {
    take: () =>
      page.evaluate(() => (window as unknown as { rowRenders: string[] }).rowRenders.splice(0)),
  };
}
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 400)),
  );
test('scrolling and live progress re-render only the rows they change', async ({ page }) => {
  const rows = await countRowRenders(page);
  await open(page);
  await settle(page);
  expect((await rows.take()).length).toBeGreaterThan(0);
  expect(await page.locator('[data-transcript-entry]').count()).toBeGreaterThan(3);
  await transcript(page).hover();
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -120);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await settle(page);
  const anchor = () =>
    page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor);
  await expect.poll(anchor).not.toBeNull();
  // Each settled save re-renders only the rows gaining or losing the reading anchor.
  expect((await rows.take()).length).toBeLessThan(24);
  // Twenty scroll events save one settled anchor, re-rendering at most the two rows it moves between.
  for (let i = 0; i < 20; i++)
    await transcript(page).evaluate(async (element) => {
      element.scrollTop -= 1;
      await new Promise(requestAnimationFrame);
    });
  await settle(page);
  expect((await rows.take()).length).toBeLessThanOrEqual(2);
  // The wheel may have scrolled output inside a row and left the list following.
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  if (await jump.isVisible()) await jump.click();
  await page.evaluate(() => window.demo.transcript!.live('First live progress'));
  await expect(page.locator('[data-transcript-live]')).toContainText('First live progress');
  await settle(page);
  await rows.take();
  for (let i = 0; i < 5; i++)
    await page.evaluate((i) => window.demo.transcript!.live(`Further live progress ${i}`), i);
  await expect(page.locator('[data-transcript-live]')).toContainText('Further live progress 4');
  await settle(page);
  const renders = await rows.take();
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.filter((id) => !id.startsWith('live:'))).toEqual([]);
});
test('a row re-renders when its own disclosure, content or Find state changes', async ({
  page,
}) => {
  const rows = await countRowRenders(page);
  await open(page);
  await settle(page);
  await rows.take();
  // Folding the long output's step, opened by open(), changes the row's expanded state.
  const card = answer(page)
    .getByRole('button', { name: /^Activity/ })
    .first();
  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await settle(page);
  expect(await rows.take()).toContain('reading-179');
  // Opening it again shows its output, with its content loaded.
  await card.click();
  await expect(answer(page).getByText(/Read more/)).toBeVisible();
  await settle(page);
  expect(await rows.take()).toContain('reading-179');
  await page.evaluate(() => window.demo.transcript!.setEntry(179, ['Find the needle here.']));
  await settle(page);
  await rows.take();
  await transcript(page).focus();
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: 'Find in conversation', exact: true }).fill('needle');
  await expect(page.getByRole('status').filter({ hasText: /1 of 1 match/ })).toBeVisible();
  await settle(page);
  expect(await rows.take()).toContain('reading-179');
});
test('Copy keeps following live output', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.demo.transcript!.live('Streaming output'));
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  await expect(jump).toHaveCount(0);
  await page
    .locator('[data-transcript-live]')
    .getByRole('button', { name: 'Copy message', exact: true })
    .click();
  await page.evaluate(() => window.demo.transcript!.live('Streaming output, continued'));
  await expect(page.locator('[data-transcript-live]')).toContainText('continued');
  await expect(jump).toHaveCount(0);
});
test('reading pins share one set of document listeners, released with the last subscriber', async ({
  page,
}) => {
  await page.goto('/?local&design&transcript');
  const result = await page.evaluate(
    async (path) => {
      const added: string[] = [],
        removed: string[] = [];
      const add = document.addEventListener.bind(document),
        remove = document.removeEventListener.bind(document);
      document.addEventListener = ((type: string, ...rest: [EventListener]) => {
        added.push(type);
        add(type, ...rest);
      }) as typeof document.addEventListener;
      document.removeEventListener = ((type: string, ...rest: [EventListener]) => {
        removed.push(type);
        remove(type, ...rest);
      }) as typeof document.removeEventListener;
      const pins = (await import(/* @vite-ignore */ path)) as ReadingPins;
      const node = document.createElement('p');
      node.textContent = 'Pinned reading text';
      document.body.append(node);
      let first = 0,
        second = 0;
      const releaseFirst = pins.subscribeReadingChanges(() => first++);
      const releaseSecond = pins.subscribeReadingChanges(() => second++);
      const listening = [...added];
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const pinned = pins.isReadingNodePinned(node);
      releaseFirst();
      const afterFirst = [...removed];
      releaseSecond();
      getSelection()!.removeAllRanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.addEventListener = add;
      document.removeEventListener = remove;
      return { listening, notified: [first, second], pinned, afterFirst, removed };
    },
    `/@fs${resolve('src/renderer/chat/reading-pin.ts')}`,
  );
  expect(result.listening).toEqual(['selectionchange', 'focusin', 'focusout']);
  expect(result.notified[0]).toBeGreaterThan(0);
  expect(result.notified[1]).toBe(result.notified[0]);
  expect(result.pinned).toBe(true);
  expect(result.afterFirst).toEqual([]);
  expect(result.removed).toEqual(['selectionchange', 'focusin', 'focusout']);
});
test('footnotes render as plain references with a visually hidden label', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.setEntry(179, [
      'A claim with a footnote[^moon] and [another](https://example.com/read).\n\n[^moon]: The footnote text.\n',
    ]),
  );
  const row = answer(page);
  await expect(row.getByText('The footnote text.')).toBeVisible();
  await expect(row.locator('sup')).toHaveText('1');
  await expect(row.locator('sup a, sup code')).toHaveCount(0);
  await expect(row.getByText(/user-content-fn/)).toHaveCount(0);
  await expect(row.getByText('↩')).toHaveCount(0);
  await expect(row.getByRole('link')).toHaveCount(1);
  const label = row.getByRole('heading', { name: 'Footnotes', exact: true });
  await expect(label).toBeAttached();
  const box = (await label.boundingBox())!;
  expect(box.width * box.height).toBeLessThanOrEqual(1);
  await row.locator('sup').click();
  expect(await page.evaluate(() => window.demo.transcript!.links)).toEqual([]);
  expect(errors).toEqual([]);
});
test('a Copied notice clears itself while a failure stays', async ({ page }) => {
  await open(page);
  await answer(page).getByRole('button', { name: 'Copy code', exact: true }).click();
  const copied = page.getByRole('status').filter({ hasText: 'Copied.' });
  await expect(copied).toBeVisible();
  await expect(copied).toHaveCount(0, { timeout: 8000 });
  await page.evaluate(() => {
    window.demo.transcript!.native.copy = async () => {
      throw Error('Copy failed in the fixture.');
    };
  });
  await answer(page).getByRole('button', { name: 'Copy code', exact: true }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'Copy failed in the fixture.' });
  await expect(failure).toBeVisible();
  await page.waitForTimeout(5000);
  await expect(failure).toBeVisible();
  await expect(page.getByText('Copied.', { exact: true })).toHaveCount(0);
});
