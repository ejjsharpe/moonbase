import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFindHighlight } from './find-highlight.ts';
const output = resolve('../../test-results/transcript-111');
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
  await answer(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
}
const transcript = (page: Page) =>
  page.getByRole('region', { name: 'Chat transcript', exact: true });
const answer = (page: Page) => page.locator('[data-transcript-entry="reading-179"]');
for (const pin of ['pointer', 'focus', 'selection'] as const)
  for (const release of ['release', 'latest'] as const)
    test(`oldest row ${pin} pin survives first live output until ${release}`, async ({ page }) => {
      await open(page);
      await page.evaluate(async () => {
        const controller = window.demo.application.chat!;
        for (let i = 0; i < 4; i++) await controller.showEarlier();
        for (let i = 0; i < 8 && !controller.getSnapshot().transcript.atLatest; i++)
          await controller.showLater();
      });
      await expect(page.locator('[data-transcript-entry]')).toHaveCount(128);
      await transcript(page).dispatchEvent('wheel', { deltaY: 1 });
      await transcript(page).evaluate((element) => {
        const first = element.querySelector('[data-transcript-entry]')!;
        const top = element
          .querySelector('[data-transcript-chrome]')!
          .getBoundingClientRect().bottom;
        element.scrollTop += first.getBoundingClientRect().top - top + 60;
      });
      const first = page.locator('[data-transcript-entry]').first();
      const firstId = await first.getAttribute('data-transcript-entry');
      await expect
        .poll(() =>
          page.evaluate(
            () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
          ),
        )
        .not.toBe(firstId);
      const pre = first.locator('pre');
      if (pin === 'pointer') {
        const box = (await pre.locator('code').boundingBox())!;
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
      } else if (pin === 'focus') await pre.evaluate((node) => node.focus({ preventScroll: true }));
      else {
        await transcript(page).evaluate((node) => node.focus({ preventScroll: true }));
        await pre.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
        });
      }
      await first.evaluate((node) => node.setAttribute('data-oldest-retained', 'true'));
      const selected = await page.evaluate(() => window.getSelection()!.toString());
      if (pin !== 'focus') expect(selected.length).toBeGreaterThan(0);
      const anchor = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
      );
      expect(anchor?.entryId).toBeTruthy();
      expect(anchor?.entryId).not.toBe(firstId);
      for (const text of ['First live appearance', 'Further live progress']) {
        await page.evaluate((text) => window.demo.transcript!.live(text), text);
        await expect(page.locator('[data-oldest-retained]')).toHaveCount(1);
        expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
        if (pin !== 'selection') await expect(pre).toBeFocused();
        await expect(page.locator('[data-transcript-entry], [data-transcript-live]')).toHaveCount(
          128,
        );
        await expect(page.locator('[data-transcript-live]')).toHaveCount(0);
      }
      if (pin === 'pointer' && release === 'release') {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: resolve(output, 'r5-oldest-pointer-retained.png') });
      }
      if (release === 'latest')
        await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
      else {
        await page.evaluate(() => window.getSelection()!.removeAllRanges());
        if (pin === 'pointer') {
          await expect(pre).toBeFocused();
          await expect(page.locator('[data-oldest-retained]')).toHaveCount(1);
        }
        await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
      }
      await expect(page.locator('[data-transcript-live]')).toContainText('Further live progress');
      await expect(page.locator('[data-oldest-retained]')).toHaveCount(0);
      expect(
        await page.locator('[data-transcript-entry], [data-transcript-live]').count(),
      ).toBeLessThanOrEqual(128);
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('');
    });
test('a durable reading anchor in the newest window keeps the generic live text part visible', async ({
  page,
}) => {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await page.evaluate(async () => {
    await window.demo.transcript!.live('Current generic text source');
    window.demo.application.chat!.setTranscriptView({
      anchor: { entryId: 'reading-179', partId: 'm0.b0', offset: 16 },
      expanded: [],
    });
  });
  await expect(page.locator('[data-transcript-live] [data-transcript-part="m0.b0"]')).toContainText(
    'Current generic text source',
  );
  const boundary = await page.evaluate(() => {
    const state = window.demo.application.chat!.getSnapshot().transcript;
    return { following: state.atLatest, later: state.later };
  });
  expect(boundary).toEqual({ following: false, later: false });
  await page.evaluate(async () => {
    const controller = window.demo.application.chat!;
    for (let page = 0; page < 4; page++) await controller.showEarlier();
    for (let page = 0; page < 8 && !controller.getSnapshot().transcript.atLatest; page++)
      await controller.showLater();
    const state = controller.getSnapshot().transcript;
    controller.setTranscriptView({
      anchor: { entryId: state.entries[0]!.id, partId: 'm0.b0', offset: 0 },
      expanded: [],
    });
  });
  await expect(page.locator('[data-transcript-entry]')).toHaveCount(128);
  await expect(page.locator('[data-transcript-live]')).toHaveCount(0);
  const first = page.locator('[data-transcript-entry]').first();
  await first.locator('pre').focus();
  const selected = await first.locator('pre').evaluate((node) => {
    node.dataset.readingSelection = 'retained';
    const range = document.createRange();
    range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    return window.getSelection()!.toString();
  });
  await page.evaluate(() => window.demo.transcript!.live('Current generic text source'));
  await expect(page.locator('[data-reading-selection="retained"]')).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.locator('[data-transcript-live]')).toContainText('Current generic text source');
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

for (const mode of ['durable', 'live'] as const)
  test(`${mode} anchored disclosure explicitly collapses without losing its viewport or other expansions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 540 });
    await open(page);
    if (mode === 'live')
      await page.evaluate(async () => {
        await window.demo.transcript!.live(
          'Live disclosure source',
          Array.from({ length: 5 }, (_, index) => `Output ${index}\n` + 'line\n'.repeat(100)),
        );
        await window.demo.application.chat!.jumpToLatest();
      });
    const row = mode === 'live' ? page.locator('[data-transcript-live]') : answer(page);
    if (mode === 'live') await row.getByRole('button', { name: /^Activity/ }).click();
    const part = row.locator('[data-transcript-part="m0.b1"]');
    for (const id of ['m0.b2', 'm0.b3'])
      await row
        .locator(`[data-transcript-part="${id}"]`)
        .getByRole('button', { expanded: false })
        .first()
        .click();
    const others = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view.expanded,
    );
    await page.evaluate((mode) => {
      const controller = window.demo.application.chat!;
      const state = controller.getSnapshot();
      const summary =
        mode === 'live'
          ? state.snapshot!.run!.transcript!
          : state.transcript.entries.find((entry) => entry.id === 'reading-179')!.transcript!;
      const descriptor = summary.parts.find((part) => part.partId === 'm0.b1')!;
      const anchor =
        summary.source.kind === 'live'
          ? {
              backendId: controller.backendId,
              source: summary.source,
              partId: descriptor.partId,
              bytes: descriptor.bytes,
              revision: descriptor.revision,
              offset: 16,
            }
          : { entryId: 'reading-179', partId: descriptor.partId, offset: 16 };
      controller.setTranscriptView({ anchor, expanded: state.transcript.view.expanded });
    }, mode);
    const offset = () =>
      part.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          document.querySelector('[data-transcript-chrome]')!.getBoundingClientRect().bottom,
      );
    await expect.poll(offset).toBeCloseTo(16, 0);
    const anchor = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
    );
    const toggle = part.getByRole('button', { expanded: true }).first();
    await toggle.click();
    await expect(part.getByRole('button', { expanded: false }).first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(part.locator('pre')).toHaveCount(0);
    await page.evaluate(() =>
      window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot)),
    );
    await expect(part.getByRole('button', { expanded: false }).first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect.poll(offset).toBeCloseTo(16, 0);
    expect(
      await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.view.expanded,
      ),
    ).toEqual(others);
    expect(
      await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
    ).toEqual(anchor);
    for (const id of ['m0.b2', 'm0.b3'])
      await expect(
        row
          .locator(`[data-transcript-part="${id}"]`)
          .getByRole('button', { expanded: true })
          .first(),
      ).toBeVisible();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `r1-${mode}-collapsed.png`) });
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
  await expect(row.locator('table')).toHaveCount(1);
  await expect(row.locator('th').last()).toHaveCSS('text-align', 'right');
  await expect(row.locator('tbody tr').first().locator('td').last()).toHaveCSS(
    'text-align',
    'right',
  );
  await expect(row.locator('blockquote')).toHaveCount(1);
  await expect(row.locator('ul')).toHaveCount(2);
  await expect(row.locator('script, svg, img, style, iframe, button[onclick]')).toHaveCount(0);
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
  await row.getByRole('button', { name: 'Output', exact: true }).click();
  await expect(row.getByText(/Read more/)).toBeVisible();
  await row.getByRole('button', { name: 'Copy part', exact: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)?.length))
    .toBeGreaterThan(90000);
  await row.getByRole('button', { name: 'Load more parts' }).click();
  await expect(row.getByRole('button', { name: /Thinking.*redacted/ })).toBeVisible();
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
    .toBe(640);
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
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Native action cancelled' }),
  ).toBeVisible();
  await expect(page.getByText('Copied.', { exact: true })).toHaveCount(0);
});
test('128-row reuse, unchanged sibling DOM, selection/focus and anchors during live progress/prepend/resize/folding', async ({
  page,
}) => {
  await open(page);
  // Enter the maximum headless window through its public navigation, then return to its latest edge.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await window.demo.application.chat!.showEarlier();
    for (let i = 0; i < 8 && !window.demo.application.chat!.getSnapshot().transcript.atLatest; i++)
      await window.demo.application.chat!.showLater();
  });
  await expect(page.locator('[data-transcript-entry], [data-transcript-live]')).toHaveCount(128);
  const before = await page.evaluate(() => {
    const row = document.querySelector('[data-transcript-entry="reading-179"]')!;
    row.setAttribute('data-sibling-retained', 'true');
    const paragraph = row.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      metrics: { ...window.demo.transcript!.metrics },
      text: selection.toString(),
      y: paragraph.getBoundingClientRect().top,
    };
  });
  const timings = await page.evaluate(async () => {
    const elapsed: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await window.demo.transcript!.live(
        `Live chunk ${i}\n\n\`\`\`typescript\nconst live = ${i};\n\`\`\`\n`,
      );
      await new Promise(requestAnimationFrame);
      elapsed.push(performance.now() - start);
    }
    return elapsed;
  });
  expect(await page.locator('[data-sibling-retained]').count()).toBe(1);
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(before.text);
  await expect(page.locator('[data-transcript-entry], [data-transcript-live]')).toHaveCount(128);
  const metrics = await page.evaluate(() => ({ ...window.demo.transcript!.metrics }));
  // Only the changed live message is re-lexed/re-tokenized; unchanged 128-row history is reused.
  expect(metrics.lex - before.metrics.lex).toBeLessThanOrEqual(22);
  expect(metrics.tokenize - before.metrics.tokenize).toBeLessThanOrEqual(22);
  expect(metrics.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(metrics.messages).toBeLessThanOrEqual(128);
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'responsiveness.json'),
    JSON.stringify(
      {
        rows: 128,
        updates: timings.length,
        timingsMs: timings,
        before: before.metrics,
        after: metrics,
      },
      null,
      2,
    ),
  );
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await transcript(page).evaluate((element) => {
    element.scrollTop = 2000;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const position = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
  );
  expect(position).not.toBeNull();
  await page.evaluate(() => window.demo.transcript!.live('A much larger live answer\n'.repeat(40)));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
    ),
  ).toBe(position!.entryId);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  const live = page.getByRole('article', { name: 'Live response' });
  await expect(live).toBeVisible();
  const latestBefore = await page.evaluate(() => ({ ...window.demo.transcript!.metrics }));
  for (let index = 0; index < 10; index++) {
    await page.evaluate(
      (index) => window.demo.transcript!.live(`Visible live update ${index}`),
      index,
    );
    await expect(live.getByText(`Visible live update ${index}`, { exact: true })).toBeVisible();
  }
  const latestAfter = await page.evaluate(() => ({ ...window.demo.transcript!.metrics }));
  expect(latestAfter.lex - latestBefore.lex).toBe(10);
  expect(latestAfter.tokenize - latestBefore.tokenize).toBe(0);
  await writeFile(
    resolve(output, 'visible-live-reuse.json'),
    JSON.stringify({ before: latestBefore, after: latestAfter, visibleUpdates: 10 }, null, 2),
  );
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
  await expect(live.locator('pre code span')).toHaveCount(0);
  await page.evaluate(() =>
    window.demo.transcript!.live(
      'Replacement with &amp; and &#x1f314; <img src="https://example.com/no-fetch" onerror="alert(1)">',
    ),
  );
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(live.getByText(/Replacement with & and 🌔/)).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
  await expect(live.locator('img')).toHaveCount(0);
});

test('automatic and keyboard history loading preserve semantic viewport anchors and session restoration', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  const initial = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.entries.length,
  );
  await transcript(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect
    .poll(() =>
      page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.entries.length),
    )
    .toBeGreaterThan(initial);
  const older = page.getByRole('button', { name: 'Load earlier', exact: true });
  await older.focus();
  await page.keyboard.press('Enter');
  await expect(older).toBeFocused();
  const anchor = await page.evaluate(() => {
    const controller = window.demo.application.chat!,
      element = document.querySelector<HTMLElement>('[aria-label="Chat transcript"]')!;
    element.scrollTop = 1000;
    element.dispatchEvent(new Event('scroll'));
    return controller.getSnapshot().transcript.view.anchor;
  });
  await expect
    .poll(() => page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.loading))
    .toBe(false);
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
      ),
    )
    .toBe(anchor!.entryId);
  await page.evaluate(async () => {
    const controller = window.demo.application.chat!;
    await controller.jumpToEntry('reading-179');
    controller.setTranscriptView({
      anchor: { entryId: 'reading-179', partId: 'm0.b5', offset: 16 },
      expanded: [],
    });
  });
  await expect(
    answer(page).getByText('Published unknown record description', { exact: true }),
  ).toBeVisible();
});

test('history retry repeats the captured navigation direction after a public read failure', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Load earlier', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read later', exact: true })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Read later', exact: true }).click();
  await page.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toHaveCount(0);
  const reads = await page.evaluate(() =>
    window.demo.chat.calls.filter((call) => call.startsWith('navigation:')),
  );
  expect(reads).toHaveLength(2);
  expect(reads[1]).toBe(reads[0]);
});

test('retired live DOM stays pinned for focus/selection and never enters durable view memory', async ({
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
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
    ),
  ).not.toBe('live');
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.locator('[data-retained-selection]')).toHaveCount(0);
});

test('application live-part memory restores a saved row after changed text and falls back nearby after retirement', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.live(
      'Live reading\n'.repeat(80),
      Array.from({ length: 5 }, (_, index) => `Output ${index}\n` + 'retained output\n'.repeat(80)),
    );
    const controller = window.demo.application.chat!;
    await controller.jumpToLatest();
    const source = controller.getSnapshot().snapshot!.run!.transcript!.source;
    if (source.kind !== 'live') throw Error('Expected live fixture');
    await controller.loadTranscriptManifest(source);
    await controller.loadTranscriptManifest(source);
    const part = controller
      .getSnapshot()
      .transcript.manifest!.parts.find((part) => part.partId === 'm0.b5')!;
    controller.setTranscriptView({
      anchor: {
        backendId: controller.backendId,
        source,
        partId: part.partId,
        bytes: part.bytes,
        revision: part.revision,
        offset: 16,
      },
      expanded: ['remembered-live-disclosure'],
    });
  });
  const selected = page.locator('[data-transcript-live] [data-transcript-part="m0.b5"]');
  await expect(selected.getByText('Output 4', { exact: false })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.demo.application
          .chat!.getSnapshot()
          .transcript.content.some(
            (item) => item.selection.partId === 'm0.b5' && item.status === 'complete',
          ),
      ),
    )
    .toBe(true);
  const before = await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    const part = document.querySelector<HTMLElement>(
      '[data-transcript-live] [data-transcript-part="m0.b5"]',
    )!;
    const chrome = document.querySelector<HTMLElement>('[data-transcript-chrome]')!;
    controller.setTranscriptView({
      ...controller.getSnapshot().transcript.view,
      anchor: {
        ...controller.getSnapshot().transcript.view.anchor!,
        offset: part.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom,
      },
    });
    Object.assign(window, { replacedChat: controller });
    return controller.getSnapshot().transcript.view.anchor;
  });
  expect(before?.source?.kind).toBe('live');
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.evaluate(() =>
    window.demo.transcript!.live(
      'Live reading\n'.repeat(80),
      Array.from(
        { length: 5 },
        (_, index) =>
          `Output ${index}\n` +
          'retained output\n'.repeat(80) +
          (index === 4 ? 'later append\n' : ''),
      ),
    ),
  );
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(selected.getByText('Output 4', { exact: false })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.demo.application
          .chat!.getSnapshot()
          .transcript.content.some(
            (item) => item.selection.partId === 'm0.b5' && item.status === 'complete',
          ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      selected.evaluate(
        (part) =>
          part.getBoundingClientRect().top -
          document.querySelector('[data-transcript-chrome]')!.getBoundingClientRect().bottom,
      ),
    )
    .toBeCloseTo(before!.offset, 0);
  const restored = await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    const part = document.querySelector<HTMLElement>(
      '[data-transcript-live] [data-transcript-part="m0.b5"]',
    )!;
    const chrome = document.querySelector<HTMLElement>('[data-transcript-chrome]')!;
    return {
      replacement:
        controller !== (window as typeof window & { replacedChat: unknown }).replacedChat,
      anchor: controller.getSnapshot().transcript.view.anchor,
      offset: part.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom,
    };
  });
  expect(restored.replacement).toBe(true);
  expect(restored.anchor).toEqual(before);
  expect(Math.abs(restored.offset - before!.offset)).toBeLessThan(3);
  await page.evaluate(() => {
    const run = window.demo.chat.snapshot.run!;
    if (run.transcript!.source.kind !== 'live') throw Error('Expected live fixture');
    run.transcript!.source = { ...run.transcript!.source, attempt: 1, incarnation: 'b'.repeat(64) };
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(selected.getByText('Output 4', { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: /Application effect failed\s*Retry parts/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(page.locator('[data-transcript-live]')).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: /Application effect failed\s*Retry parts/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
    )
    .toBeNull();
  expect(
    await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.expanded),
  ).toEqual([]);
  await page.evaluate(() => {
    window.demo.chat.snapshot.run = null;
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(page.locator('[data-transcript-live]')).toHaveCount(0);
  await expect(answer(page)).toBeAttached();
  await expect(page.getByRole('alert').filter({ hasText: 'anchored live source' })).toHaveCount(0);
});

for (const navigation of ['wheel', 'keyboard', 'pointer-disclosure', 'child-keyboard'] as const)
  for (const outcome of navigation.includes('-') ? ['success', 'error'] : ['success'])
    test(`${navigation} navigation releases saved restoration after held manifest ${outcome}`, async ({
      page,
    }) => {
      await open(page);
      await page.evaluate(async () => {
        await window.demo.transcript!.live(
          'Live reading\n\n'.repeat(80),
          Array.from({ length: 5 }, (_, index) => `Output ${index}\n` + 'line\n'.repeat(80)),
        );
        const controller = window.demo.application.chat!;
        await controller.jumpToLatest();
        const source = controller.getSnapshot().snapshot!.run!.transcript!.source;
        await controller.loadTranscriptManifest(source);
        await controller.loadTranscriptManifest(source);
      });
      await page
        .locator('[data-transcript-live]')
        .getByRole('button', { name: /^Activity/ })
        .click();
      await page.evaluate(() => {
        const controller = window.demo.application.chat!;
        const source = controller.getSnapshot().snapshot!.run!.transcript!.source;
        const part = controller
          .getSnapshot()
          .transcript.manifest!.parts.find((part) => part.partId === 'm0.b5')!;
        if (source.kind !== 'live') throw Error('Expected live source');
        controller.setTranscriptView({
          anchor: {
            backendId: controller.backendId,
            source,
            partId: part.partId,
            bytes: part.bytes,
            revision: part.revision,
            offset: 16,
          },
          expanded: [
            ...controller.getSnapshot().transcript.view.expanded,
            'keep-another-disclosure',
          ],
        });
      });
      await expect(
        page.locator('[data-transcript-live] [data-transcript-part="m0.b5"] pre'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
      await page.evaluate((outcome) => {
        const original = window.demo.chat.dependencies.chat.command;
        const gate = Promise.withResolvers<void>();
        Object.assign(window, { releaseManifest: () => gate.resolve(), manifestHeld: false });
        window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
          if (
            operation === 'getChatTranscriptContent' &&
            'source' in input &&
            !('selection' in input)
          ) {
            Object.assign(window, { manifestHeld: true });
            await gate.promise;
            if (outcome === 'error') throw Error('Controlled manifest failure');
          }
          return original(operation, input, options) as never;
        };
      }, outcome);
      await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as typeof window & { manifestHeld: boolean }).manifestHeld),
        )
        .toBe(true);
      if (navigation === 'wheel') {
        await transcript(page).hover();
        await page.mouse.wheel(0, 480);
      } else if (navigation === 'keyboard') {
        await transcript(page).focus();
        await page.keyboard.press('PageDown');
      } else {
        const button = page
          .locator('[data-transcript-live] [data-transcript-part="m0.b1"]')
          .getByRole('button', { expanded: false });
        await button.evaluate((element) => {
          const root = element.closest<HTMLElement>('[aria-label="Chat transcript"]')!;
          const chrome = root.querySelector('[data-transcript-chrome]')!;
          root.scrollTop +=
            element.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom - 16;
        });
        if (navigation === 'pointer-disclosure') {
          await button.click();
          await expect(
            page
              .locator('[data-transcript-live] [data-transcript-part="m0.b1"]')
              .getByRole('button', { expanded: true }),
          ).toBeVisible();
        } else {
          await button.focus();
          await page.keyboard.press('PageUp');
        }
      }
      await expect
        .poll(() =>
          page.evaluate(() => {
            const anchor = window.demo.application.chat!.getSnapshot().transcript.view.anchor;
            return anchor?.source ? anchor.partId !== 'm0.b5' : !!anchor?.entryId;
          }),
        )
        .toBe(true);
      let previousTop = -1;
      await expect
        .poll(async () => {
          const top = await transcript(page).evaluate((element) => element.scrollTop);
          const settled = top > 0 && top === previousTop;
          previousTop = top;
          return settled;
        })
        .toBe(true);
      const before = await transcript(page).evaluate((element) => ({
        top: element.scrollTop,
        anchor: window.demo.application.chat!.getSnapshot().transcript.view.anchor,
      }));
      await page.evaluate(() =>
        (window as typeof window & { releaseManifest(): void }).releaseManifest(),
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => window.demo.application.chat!.getSnapshot().transcript.manifest?.status,
          ),
        )
        .toBe(outcome === 'success' ? 'partial' : 'error');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (outcome === 'success')
        expect(await transcript(page).evaluate((element) => element.scrollTop)).toBeCloseTo(
          before.top,
          0,
        );
      else await expect(page.getByRole('alert').filter({ hasText: 'Retry parts' })).toBeVisible();
      await expect
        .poll(() =>
          transcript(page).evaluate((element) => {
            const anchor = window.demo.application.chat!.getSnapshot().transcript.view.anchor!;
            const row = [
              ...element.querySelectorAll<HTMLElement>(
                '[data-transcript-entry], [data-transcript-live]',
              ),
            ].find((row) =>
              anchor.source
                ? row.dataset.transcriptLive === JSON.stringify(anchor.source)
                : row.dataset.transcriptEntry === anchor.entryId,
            )!;
            const node = anchor.partId
              ? [...row.querySelectorAll<HTMLElement>('[data-transcript-part]')].find(
                  (node) => node.dataset.transcriptPart === anchor.partId,
                )!
              : row;
            return (
              node.getBoundingClientRect().top -
              Math.max(
                element.getBoundingClientRect().top,
                element.querySelector('[data-transcript-chrome]')!.getBoundingClientRect().bottom,
              )
            );
          }),
        )
        .toBeCloseTo(before.anchor!.offset, 0);
      expect(
        await page.evaluate(
          () => window.demo.application.chat!.getSnapshot().transcript.view.expanded,
        ),
      ).toContain('keep-another-disclosure');
      expect(
        await page.evaluate(
          () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
        ),
      ).toEqual(before.anchor);
      if (navigation.includes('-')) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: resolve(output, `r4-${navigation}-${outcome}.png`) });
      }
    });

test('partial Markdown cannot copy a different complete-source code node', async ({ page }) => {
  await open(page);
  const prefix = 'x'.repeat(15993) + '\n\n```js';
  await page.evaluate(
    (text) => window.demo.transcript!.live(text),
    prefix + '`invalid\n\n```python\nWRONG BLOCK\n```\n',
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
  await expect(row.getByRole('button', { name: /^Thinking/ })).toHaveAttribute(
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
  // Replacing the painted text node collapses its range; the part's observer repaints it.
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
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).press('Meta+p');
  await expect(page.getByRole('dialog', { name: 'Find file', exact: true })).toBeVisible();
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
  const thinking = page
    .locator('[data-transcript-entry="reading-0"]')
    .getByRole('button', { name: /^Thinking/ });
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

test('Find Previous replays an evicted part manifest without changing its query cutoff', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const texts = Array.from({ length: 300 }, (_, index) => `thought ${index}`);
    texts[0] = 'first NEEDLE';
    texts[299] = 'last NEEDLE';
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
    .toEqual([expect.objectContaining({ text: 'NEEDLE', part: 'm0.b299' })]);
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
      const thinking = row.getByRole('button', { name: /^Thinking/ });
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
        probe.manual = window.demo.application.chat!.jumpToEntry('reading-50');
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
      expect(final.view.anchor?.entryId).toBe('reading-50');
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
      await region.getByRole('button', { name: 'Find', exact: true }).click();
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
test('the reading position and its view memory survive content growing above it', async ({
  page,
}) => {
  await open(page);
  await transcript(page).hover();
  await page.mouse.wheel(0, -600);
  let previousTop = -1;
  await expect
    .poll(async () => {
      const top = await transcript(page).evaluate((element) => element.scrollTop);
      const settled = top === previousTop;
      previousTop = top;
      return settled;
    })
    .toBe(true);
  const top = () => answer(page).evaluate((row) => row.getBoundingClientRect().top);
  const before = await top();
  const anchor = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
  );
  expect(anchor?.entryId).toBeTruthy();
  // Hydration, unfolding or an image load above the viewport grows an earlier row.
  await page.locator('[data-transcript-entry="reading-170"]').evaluate((row) => {
    row.style.paddingTop = '600px';
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(Math.abs((await top()) - before)).toBeLessThan(1);
  expect(
    await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
  ).toEqual(anchor);
});
test('a restoration that falls back to a nearby row keeps the saved view memory', async ({
  page,
}) => {
  await open(page);
  // Supplied memory names a row outside the loaded latest window.
  const saved = { entryId: 'reading-0', offset: 16 };
  const before = await transcript(page).evaluate((element) => element.scrollTop);
  await page.evaluate((anchor) => {
    const controller = window.demo.application.chat!;
    if (controller.getSnapshot().transcript.entries.some((entry) => entry.id === anchor.entryId))
      throw new Error('The saved row must be outside the loaded window.');
    controller.setTranscriptView({ anchor, expanded: [] });
  }, saved);
  await expect
    .poll(() => transcript(page).evaluate((element) => element.scrollTop))
    .not.toBe(before);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // Its own fallback scroll records nothing, so the saved row can still be restored.
  expect(
    await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
  ).toEqual(saved);
});
