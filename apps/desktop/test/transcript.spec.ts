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
  await row.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
    .toBe('  const moon = "🌔";\t\r\nconsole.log(moon);\r\n');
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
  expect(
    await page
      .getByRole('main', { name: 'Agent workspace', exact: true })
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(640);
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
    for (let i = 0; i < 4; i++) await window.demo.application.chat!.older();
    for (let i = 0; i < 8 && !window.demo.application.chat!.getSnapshot().transcript.atLatest; i++)
      await window.demo.application.chat!.later();
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
  await expect(live.getByRole('button', { name: /Show all 18001 lines/ })).toBeVisible();
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
    .toBe('const value = 1;\n'.repeat(18000));
  await live.getByRole('button', { name: /Show all 18001 lines/ }).click();
  await expect(live.getByRole('button', { name: 'Fold code', exact: true })).toBeVisible();
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
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await expect(page.locator('[data-retained-selection]')).toHaveCount(0);
});

test('application live-part memory restores only the exact source across panel replacement, then reports retirement', async ({
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
      expanded: [],
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
  await page.evaluate(() => {
    const original = window.demo.chat.dependencies.chat.command;
    const gate = Promise.withResolvers<void>();
    let released = false;
    Object.assign(window, {
      releaseLiveProof: () => {
        released = true;
        gate.resolve();
      },
    });
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      if (
        operation === 'getChatTranscriptContent' &&
        'selection' in input &&
        input.selection?.partId === 'm0.b5' &&
        !released
      )
        await gate.promise;
      return original(operation, input, options) as never;
    };
  });
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(page.getByText('Restoring the saved live position…', { exact: true })).toBeVisible();
  await expect(selected.getByText('Output 4', { exact: false })).toHaveCount(0);
  await page.evaluate(() =>
    (window as typeof window & { releaseLiveProof(): void }).releaseLiveProof(),
  );
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
      status: controller.getSnapshot().transcript.viewStatus,
      offset: part.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom,
    };
  });
  expect(restored.replacement).toBe(true);
  expect(restored.anchor).toEqual(before);
  expect(restored.status).toBe('ready');
  expect(Math.abs(restored.offset - before!.offset)).toBeLessThan(3);
  await page.evaluate(() => {
    const run = window.demo.chat.snapshot.run!;
    if (run.transcript!.source.kind !== 'live') throw Error('Expected live fixture');
    run.transcript!.source = { ...run.transcript!.source, attempt: 1, incarnation: 'b'.repeat(64) };
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'anchored live source retired or changed' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
  ).toEqual(before);
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'anchored live source retired or changed' }),
  ).toBeVisible();
  await expect(selected.getByText('Output 4', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
    )
    .toBeNull();
});
