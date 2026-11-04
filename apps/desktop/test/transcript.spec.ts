import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output = resolve('../../test-results/transcript-111');
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
}
const transcript = (page: Page) =>
  page.getByRole('region', { name: 'Chat transcript', exact: true });
const answer = (page: Page) => page.locator('[data-transcript-entry="reading-179"]');
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
  await expect(row.locator('table')).toHaveCount(1);
  await expect(row.locator('blockquote')).toHaveCount(1);
  await expect(row.locator('ul')).toHaveCount(2);
  await expect(row.locator('script, svg, img, style, iframe, button[onclick]')).toHaveCount(0);
  await expect(
    row.getByText('<button onclick="alert(1)">inert model control</button>', { exact: false }),
  ).toBeAttached();
  await row.getByRole('link', { name: 'Read documentation' }).click();
  expect(await page.evaluate(() => window.demo.transcript!.links)).toEqual([
    'https://example.com/read',
  ]);
  await row.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('  const moon = "🌔";\t\r\nconsole.log(moon);\r\n');
  await row.getByRole('button', { name: 'result', exact: true }).click();
  await expect(row.getByText(/Read more/)).toBeVisible();
  await row.getByRole('button', { name: 'Copy part', exact: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)?.length))
    .toBeGreaterThan(90000);
  await row.getByRole('button', { name: 'Load more parts' }).click();
  await expect(row.getByRole('button', { name: /thinking.*redacted/ })).toBeVisible();
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await row.getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'normal.png') });
  await page.setViewportSize({ width: 540, height: 844 });
  await row.getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'compact.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 450,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.screenshot({ path: resolve(output, 'zoom-200.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});
test('128-row reuse, unchanged sibling DOM, selection/focus and anchors during live progress/prepend/resize/folding', async ({
  page,
}) => {
  await open(page);
  // Enter the maximum headless window through its public navigation, then return to its latest edge.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await window.demo.application.chat!.older();
    for (let i = 0; i < 8 && !window.demo.application.chat!.getSnapshot().transcript.atLatest; i++)
      await window.demo.application.chat!.later();
  });
  await expect(page.locator('[data-transcript-entry]')).toHaveCount(128);
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
  await expect(page.locator('[data-transcript-entry]')).toHaveCount(128);
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
  await page.waitForTimeout(100);
  const position = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
  );
  expect(position).not.toBeNull();
  await page.evaluate(() => window.demo.transcript!.live('A much larger live answer\n'.repeat(40)));
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
    ),
  ).toBe(position!.entryId);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Live response' })).toBeVisible();
});

test('incomplete/unknown/oversized code remains readable and copyable; fence/reference changes invalidate only affected output', async ({
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
    window.demo.transcript!.live('```typescript\n' + 'const value = 1;\n'.repeat(4500) + '```\n'),
  );
  await page.evaluate(async () => {
    const controller = window.demo.application.chat!;
    const summary = controller.getSnapshot().snapshot!.run!.transcript!,
      part = summary.parts[0]!;
    for (let i = 0; i < 8; i++) {
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
  await expect(live.getByRole('button', { name: /Show all 4501 lines/ })).toBeVisible();
  await live.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('const value = 1;\n'.repeat(4500));
  await live.getByRole('button', { name: /Show all 4501 lines/ }).click();
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeVisible();
  expect(
    await live.locator('pre').evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await page.evaluate(() =>
    window.demo.transcript!.live(
      'Replacement with &amp; and &#x1f314; <img src="https://example.com/no-fetch" onerror="alert(1)">',
    ),
  );
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await expect(live.getByText(/Replacement with & and 🌔/)).toBeVisible();
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
  await transcript(page).evaluate((element) => {
    element.scrollTop = 20;
  });
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
});
