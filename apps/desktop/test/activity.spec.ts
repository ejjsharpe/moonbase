import { scrollToStart } from './transcript-list.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFindHighlight } from './find-highlight.ts';
const output = resolve('../../test-results/transcript-112');
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
}
const live = (page: Page) => page.locator('[data-transcript-live]');
for (const source of ['durable', 'live'] as const)
  test(`${source} failed result keeps originating call evidence through a held and failed first manifest read`, async ({
    page,
  }, testInfo) => {
    await open(page);
    await page.evaluate(async (source) => {
      const result = [
        {
          kind: 'result' as const,
          role: 'tool' as const,
          toolName: 'read',
          state: 'failed' as const,
          pairing: 'matched' as const,
          call: { entryId: 'origin', partId: 'call' },
          text: 'Partial failed output retained',
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          kind: 'details' as const,
          role: 'tool' as const,
          toolName: 'read',
          text: JSON.stringify({ detail: index }),
        })),
      ];
      await window.demo.transcript!.record([
        {
          id: 'origin',
          parts: [
            {
              kind: 'arguments',
              partId: 'call',
              toolName: 'read',
              state: 'requested',
              text: '{"path":"failed.txt"}',
            },
          ],
        },
        ...(source === 'durable' ? [{ id: 'result', role: 'tool' as const, parts: result }] : []),
      ]);
      if (source === 'live') await window.demo.transcript!.activity(result, 'none');
      const controller = window.demo.application.chat!;
      await controller.jumpToLatest();
      const state = controller.getSnapshot();
      const resultSource =
        source === 'live'
          ? state.snapshot!.run!.transcript!.source
          : state.transcript.entries.find((entry) => entry.id === 'result')!.transcript!.source;
      const command = window.demo.chat.dependencies.chat.command;
      const gate = Promise.withResolvers<void>();
      Object.assign(window, { releaseEvidenceManifest: () => gate.resolve() });
      window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
        if (
          operation === 'getChatTranscriptContent' &&
          'source' in input &&
          !('selection' in input) &&
          JSON.stringify(input.source) === JSON.stringify(resultSource)
        ) {
          await gate.promise;
          throw Error('Controlled first manifest failure');
        }
        return command(operation, input, options) as never;
      };
    }, source);
    const origin = page.locator('[data-transcript-entry="origin"]');
    const result =
      source === 'live' ? live(page) : page.locator('[data-transcript-entry="result"]');
    await expect(origin).toContainText('read · failed.txt · failed');
    await result.getByRole('button', { name: 'Load more parts', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const manifest = window.demo.application.chat!.getSnapshot().transcript.manifest;
          return [manifest?.status, manifest?.parts.length];
        }),
      )
      .toEqual(['loading', 0]);
    await expect(result).toContainText('read · failed');
    await expect(result.getByText(/read · failed ·.*Partial failed output retained/)).toBeVisible();
    await expect.soft(origin).toContainText('read · failed.txt · failed');
    await page.evaluate(() =>
      (window as typeof window & { releaseEvidenceManifest(): void }).releaseEvidenceManifest(),
    );
    await expect(result.getByRole('alert')).toContainText('Retry parts');
    await expect(result).toContainText('read · failed');
    await expect(result.getByText(/read · failed ·.*Partial failed output retained/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('failed-first-manifest.png') });
    await expect(origin).toContainText('read · failed.txt · failed');
  });
test('ordered activity stays between authored answers across manifest and history pages; exact call references alone supply failure', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const demo = window.demo.transcript!;
    await demo.record([
      {
        id: 'origin',
        parts: [
          { text: 'Before the call', kind: 'text' },
          {
            text: '{"path":"first.ts"}',
            kind: 'arguments',
            partId: 'call',
            callId: 'reused',
            toolName: 'read',
            state: 'requested',
          },
          { text: 'After the call', kind: 'text' },
        ],
      },
      ...Array.from({ length: 31 }, (_, index) => ({
        id: `middle-${index}`,
        parts: [{ text: `Answer ${index}`, kind: 'text' as const }],
      })),
      {
        id: 'other',
        parts: [
          {
            text: '{"path":"second.ts"}',
            kind: 'arguments',
            partId: 'call',
            callId: 'reused',
            toolName: 'read',
            state: 'requested',
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        parts: [
          {
            text: 'Partial first output retained',
            kind: 'result',
            role: 'tool',
            toolName: 'read',
            callId: 'reused',
            pairing: 'matched',
            call: { entryId: 'origin', partId: 'call' },
            state: 'failed',
          },
        ],
      },
      {
        id: 'ambiguous',
        role: 'tool',
        parts: [
          {
            text: 'Ambiguous output retained',
            kind: 'result',
            role: 'tool',
            toolName: 'read',
            callId: 'reused',
            pairing: 'ambiguous',
            state: 'interrupted',
          },
        ],
      },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
  const other = page.locator('[data-transcript-entry="other"]');
  await expect(other).toContainText('read · second.ts · requested · result not shown');
  await expect(other).not.toContainText('failed');
  // Rows unmount while scrolled away, so the newest row is read before scrolling to the start.
  await expect(page.locator('[data-transcript-entry="ambiguous"]')).toContainText(
    'interrupted · ambiguous',
  );
  await scrollToStart(page);
  const origin = page.locator('[data-transcript-entry="origin"]');
  await expect(origin).toContainText('read · first.ts · failed');
  await expect(origin.getByText('Before the call', { exact: true })).toBeVisible();
  await expect(origin.getByText('After the call', { exact: true })).toBeVisible();
  expect(
    await origin
      .locator('[data-transcript-part]')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-transcript-part'))),
  ).toEqual(['m0.b0', 'call', 'm0.b2']);
  await expect(origin.getByRole('button', { name: /^Activity/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});
test('requested and executed arguments, unknown JSON and interrupted partial results stay inspectable without hiding answers', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      {
        id: 'inspection',
        thinking: 'available',
        parts: [
          { text: 'Answer before activity', kind: 'text' },
          { text: 'Available thought', kind: 'thinking' },
          {
            text: '{"path":"captured.txt","content":"captured write"}',
            kind: 'arguments',
            toolName: 'write',
            state: 'requested',
          },
          {
            text: '{"path":"actual.txt","content":"actual execution"}',
            kind: 'executed-arguments',
            toolName: 'write',
            role: 'tool',
            state: 'interrupted',
          },
          {
            text: '{"opaque":true,"count":4}',
            kind: 'arguments',
            toolName: 'unknown',
            state: 'requested',
          },
          {
            text: 'partial retained output',
            kind: 'result',
            role: 'tool',
            toolName: 'unknown',
            pairing: 'unmatched',
            state: 'interrupted',
            droppedBytes: 55,
            droppedLines: 2,
          },
          {
            text: '{"published":"inert details"}',
            kind: 'details',
            role: 'tool',
            toolName: 'unknown',
          },
          { text: 'Answer after activity', kind: 'text' },
        ],
      },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
  const row = page.locator('[data-transcript-entry="inspection"]');
  await row.getByRole('button', { name: 'Load more parts' }).click();
  await expect(row.getByText('Answer before activity', { exact: true })).toBeVisible();
  await expect(row.getByText('Answer after activity', { exact: true })).toBeVisible();
  await expect(row).toContainText('interrupted');
  await row.getByRole('button', { name: /^Activity/ }).click();
  await expect(row.getByText('Available thought', { exact: true })).toHaveCount(0);
  for (const name of [
    /Thinking/,
    /write.*Requested arguments/,
    /write.*Executed arguments/,
    /unknown.*Requested arguments/,
    /unknown.*Output/,
    /unknown.*Details/,
  ])
    await row.getByRole('button', { name }).click();
  await expect(row.getByText('Available thought', { exact: true })).toBeVisible();
  await expect(row.locator('pre')).toContainText([
    'Available thought',
    'captured.txt',
    'actual.txt',
    '"opaque":true',
    'partial retained output',
    'inert details',
  ]);
  await expect(row).toContainText('55 earlier bytes / 2 lines');
  await row.getByRole('button', { name: 'Copy part', exact: true }).last().click();
  expect(await page.evaluate(() => window.demo.transcript!.copied.at(-1))).toBe(
    '{"published":"inert details"}',
  );
  await mkdir(output, { recursive: true });
  for (const [name, width, height] of [
    ['normal', 1440, 900],
    ['compact', 540, 844],
    ['zoom-200', 720, 450],
  ] as const) {
    await page.setViewportSize({ width, height });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
for (const manifest of [false, true])
  for (const focus of [false, true])
    test(`same-source thinking/tool appends after loaded manifest=${manifest} focus=${focus}`, async ({
      page,
    }, testInfo) => {
      await open(page);
      await page.evaluate(async () => {
        await window.demo.transcript!.record([
          {
            id: 'stream-origin',
            parts: [
              {
                kind: 'arguments',
                partId: 'call',
                toolName: 'bash',
                state: 'requested',
                text: '{"command":"stream moon"}',
              },
            ],
          },
        ]);
        const command = window.demo.chat.dependencies.chat.command;
        Object.assign(window, { progressHistoryReads: 0 });
        window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
          if (
            ['getChat', 'getChatHistory', 'getChatHistoryAround'].includes(operation) ||
            (operation === 'getChatTranscriptContent' && !('selection' in input))
          )
            (window as typeof window & { progressHistoryReads: number }).progressHistoryReads++;
          return command(operation, input, options) as never;
        };
      });
      const update = (suffix: string, failed = false) =>
        page.evaluate(
          async ({ suffix, failed }) => {
            await window.demo.transcript!.activity([
              { kind: 'text', text: 'Authored before' },
              { kind: 'thinking', text: `Thought ${suffix}`, state: 'running' },
              {
                kind: 'result',
                role: 'tool',
                toolName: 'bash',
                text: `Output ${suffix}`,
                state: failed ? 'failed' : 'running',
                pairing: 'matched',
                call: { entryId: 'stream-origin', partId: 'call' },
              },
              { kind: 'details', role: 'tool', toolName: 'bash', text: 'Detail A' },
              { kind: 'details', role: 'tool', toolName: 'bash', text: 'Detail B' },
            ]);
          },
          { suffix, failed },
        );
      await update('first');
      await page.evaluate(() => window.demo.application.chat!.jumpToLatest());
      const row = live(page);
      if (manifest) {
        await row.getByRole('button', { name: 'Load more parts', exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () => window.demo.application.chat!.getSnapshot().transcript.manifest?.status,
            ),
          )
          .toBe('complete');
      }
      const group = row.getByRole('button', { name: /^Activity/ });
      await group.click();
      const thought = row.locator('[data-transcript-part="m0.b1"]');
      const output = row.locator('[data-transcript-part="m0.b2"]');
      await thought.getByRole('button', { name: /Thinking/ }).click();
      await output.getByRole('button', { name: /Output/ }).click();
      const tail = row.locator('[data-transcript-part="m0.b4"]');
      if (manifest) await tail.getByRole('button', { name: /Details/ }).click();
      await expect(thought.locator('pre')).toHaveText('Thought first');
      await expect(output.locator('pre')).toHaveText('Output first');
      if (focus) await output.locator('pre').focus();
      if (manifest)
        await tail.locator('pre').evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
        });
      const source = await row.getAttribute('data-transcript-live');
      const reads = () =>
        page.evaluate(
          () => (window as typeof window & { progressHistoryReads: number }).progressHistoryReads,
        );
      const beforeReads = await reads();
      for (const suffix of ['first and next', 'first and next again']) {
        await update(suffix, suffix.endsWith('again'));
        await expect(row).toHaveAttribute('data-transcript-live', source!);
        await expect
          .soft(thought.locator('pre'))
          .toHaveText(`Thought ${suffix}`, { timeout: 1500 });
        await expect.soft(output.locator('pre')).toHaveText(`Output ${suffix}`, { timeout: 1500 });
        await expect
          .soft(row.locator('[data-transcript-activity] > ul'))
          .toContainText(`${new TextEncoder().encode(`Thought ${suffix}`).length} bytes`, {
            timeout: 1500,
          });
        if (focus) await expect(output.locator('pre')).toBeFocused();
        await expect(group).toHaveAttribute('aria-expanded', 'true');
      }
      expect(await reads()).toBe(beforeReads);
      if (manifest)
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Detail B');
      await expect
        .soft(page.locator('[data-transcript-entry="stream-origin"]'))
        .toContainText('bash · stream moon · failed', { timeout: 1500 });
      if (manifest) {
        await expect(row.getByRole('alert')).toContainText('Retry parts');
        expect(
          await row
            .locator('[data-transcript-part]')
            .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-transcript-part'))),
        ).toEqual(['m0.b0', 'm0.b1', 'm0.b2', 'm0.b3', 'm0.b4']);
      }
      await output.getByRole('button', { name: 'Copy part', exact: true }).click();
      await expect
        .configure({ soft: true })
        .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
        .toBe('Output first and next again');
      await group.click();
      await update('first and next again, held locally', true);
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await expect(thought.locator('pre')).not.toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('same-source-progress.png') });
    });
for (const outcome of ['success', 'error'] as const)
  test(`same-source current content and complete Copy survive held old content ${outcome}`, async ({
    page,
  }) => {
    await open(page);
    const update = (suffix: string) =>
      page.evaluate(async (suffix) => {
        await window.demo.transcript!.activity([
          { kind: 'text', text: 'Before' },
          { kind: 'thinking', text: 'Thought first\n'.repeat(20) + suffix, state: 'running' },
          {
            kind: 'result',
            role: 'tool',
            toolName: 'bash',
            state: 'running',
            text: 'Output first\n'.repeat(20) + suffix,
          },
          { kind: 'details', text: 'Detail A' },
          { kind: 'details', text: 'Detail B' },
        ]);
      }, suffix);
    await update('');
    await page.evaluate(() => window.demo.application.chat!.jumpToLatest());
    const row = live(page);
    await row.getByRole('button', { name: 'Load more parts', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.demo.application.chat!.getSnapshot().transcript.manifest?.status,
        ),
      )
      .toBe('complete');
    await page.evaluate((outcome) => {
      const command = window.demo.chat.dependencies.chat.command;
      const old = window.demo.application.chat!.getSnapshot().snapshot!.run!.transcript!.parts[2]!;
      const gate = Promise.withResolvers<void>();
      let failCurrent = false;
      Object.assign(window, {
        oldContentHeld: false,
        oldContentSettled: false,
        releaseOldContent: () => gate.resolve(),
        failCurrentContent: () => {
          failCurrent = true;
        },
      });
      let held = false;
      window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
        if (
          failCurrent &&
          operation === 'getChatTranscriptContent' &&
          'selection' in input &&
          input.selection?.partId === old.partId
        )
          throw Error('Controlled current read failure');
        if (
          operation === 'getChatTranscriptContent' &&
          'selection' in input &&
          input.selection?.partId === old.partId &&
          input.selection.revision === old.revision &&
          !held
        ) {
          held = true;
          const reply = await command(operation, input, options);
          Object.assign(window, { oldContentHeld: true });
          await gate.promise;
          Object.assign(window, { oldContentSettled: true });
          if (outcome === 'error') throw Error('Controlled late old read failure');
          return reply as never;
        }
        return command(operation, input, options) as never;
      };
    }, outcome);
    await row.getByRole('button', { name: /^Activity/ }).click();
    const thought = row.locator('[data-transcript-part="m0.b1"]');
    const output = row.locator('[data-transcript-part="m0.b2"]');
    await thought.getByRole('button', { name: /Thinking/ }).click();
    await output.getByRole('button', { name: /Output/ }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as typeof window & { oldContentHeld: boolean }).oldContentHeld),
      )
      .toBe(true);
    await output.locator('pre').focus();
    await update('and current appended 🌔');
    const expected = 'Output first\n'.repeat(20) + 'and current appended 🌔';
    await expect(output.locator('pre')).toHaveText(expected);
    await expect(thought.locator('pre')).toHaveText(
      'Thought first\n'.repeat(20) + 'and current appended 🌔',
    );
    await expect(output.locator('pre')).toBeFocused();
    await expect(row.getByRole('alert')).toContainText('Retry parts');
    await output.getByRole('button', { name: 'Copy part', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
      .toBe(expected);
    expect(
      await page.evaluate(
        () => (window as typeof window & { oldContentSettled: boolean }).oldContentSettled,
      ),
    ).toBe(false);
    await page.evaluate(() =>
      (window as typeof window & { releaseOldContent(): void }).releaseOldContent(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { oldContentSettled: boolean }).oldContentSettled,
        ),
      )
      .toBe(true);
    await expect(output.locator('pre')).toHaveText(expected);
    await expect(output.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() =>
      (window as typeof window & { failCurrentContent(): void }).failCurrentContent(),
    );
    await update('and current appended 🌔, then another append');
    await expect(output.getByRole('alert')).toContainText('Retry content');
  });
test('thinking/tool progress changes before completion with stable focus and expansion; group collapse survives updates', async ({
  page,
}) => {
  await open(page);
  const update = (thinking: string, result: string) =>
    page.evaluate(
      async ({ thinking, result }) => {
        await window.demo.transcript!.activity([
          { text: 'Authored before', kind: 'text' },
          { text: thinking, kind: 'thinking', state: 'running' },
          {
            text: '{"command":"printf moon"}',
            kind: 'executed-arguments',
            toolName: 'bash',
            role: 'tool',
            state: 'running',
          },
          { text: result, kind: 'result', toolName: 'bash', role: 'tool', state: 'running' },
          { text: 'Authored after', kind: 'text' },
        ]);
      },
      { thinking, result },
    );
  await update('Thinking first', 'Output first');
  const row = live(page),
    group = row.getByRole('button', { name: /^Activity/ });
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toContainText('running');
  await group.click();
  const thought = row.locator('[data-transcript-part="m0.b1"]');
  await thought.getByRole('button', { name: /Thinking/ }).click();
  const result = row.locator('[data-transcript-part="m0.b3"]');
  await result.getByRole('button', { name: /Output/ }).click();
  await result.locator('pre').focus();
  await update('Thinking first and next', 'Output first and next');
  await expect(thought.locator('pre')).toHaveText('Thinking first and next');
  await expect(result.locator('pre')).toHaveText('Output first and next');
  await expect(result.locator('pre')).toBeFocused();
  expect(await page.evaluate(() => window.demo.chat.snapshot.state)).toBe('running');
  await group.click();
  await update('Thinking first and next again', 'Output first and next again');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(thought.locator('pre')).not.toBeVisible();
  await row.getByRole('button', { name: 'Load more parts' }).click();
  await expect(row.getByText('Authored before', { exact: true })).toBeVisible();
  await expect(row.getByText('Authored after', { exact: true })).toBeVisible();
});
test('a new exact live attempt inherits neither thought content nor the previous source expansion', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.activity(
      [{ kind: 'thinking', text: 'Earlier attempt thought' }],
      'available',
      0,
    ),
  );
  await live(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  await live(page)
    .getByRole('button', { name: /^Thinking/ })
    .click();
  await expect(live(page).locator('pre')).toHaveText('Earlier attempt thought');
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: null,
      expanded: controller.getSnapshot().transcript.view.expanded,
    });
  });
  await page.evaluate(() =>
    window.demo.transcript!.activity(
      [{ kind: 'thinking', text: 'New attempt thought' }],
      'available',
      1,
    ),
  );
  await expect(live(page).getByRole('button', { name: /^Activity/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(live(page).locator('pre')).toHaveCount(0);
  await live(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  await live(page)
    .getByRole('button', { name: /^Thinking/ })
    .click();
  await expect(live(page).locator('pre')).toHaveText('New attempt thought');
  await expect(live(page)).not.toContainText('Earlier attempt thought');
});
test('reading a durable row in the latest window retains current live activity below it', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      { id: 'recent', parts: [{ kind: 'text', text: 'Recent recorded answer' }] },
    ]);
    await window.demo.application.chat!.jumpToLatest();
    await window.demo.transcript!.activity([
      {
        kind: 'result',
        role: 'tool',
        toolName: 'bash',
        state: 'running',
        text: 'Current held output',
      },
    ]);
    window.demo.application.chat!.setTranscriptView({
      anchor: { key: 'entry:recent', offset: 0 },
      expanded: [],
    });
  });
  const row = live(page);
  await expect(row).toContainText('Current held output');
  await row.getByRole('button', { name: /^Activity/ }).click();
  await row.getByRole('button', { name: /Output/ }).click();
  await expect(row.locator('pre')).toHaveText('Current held output');
});
for (const valid of [false, true])
  test(`EOF patch source without terminal newline stays exact in Copy: ${valid ? 'valid replacement' : 'truncated replacement'}`, async ({
    page,
  }, testInfo) => {
    await open(page);
    const source = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old' + (valid ? '\n+new' : '');
    await page.evaluate(async (source) => {
      await window.demo.transcript!.record([
        {
          id: 'eof-patch',
          role: 'tool',
          parts: [
            { text: source, kind: 'patch', role: 'tool', toolName: 'edit', state: 'completed' },
          ],
        },
      ]);
      await window.demo.application.chat!.jumpToLatest();
    }, source);
    const row = page.locator('[data-transcript-entry="eof-patch"]');
    await row.getByRole('button', { name: /^Activity/ }).click();
    await row.getByRole('button', { name: /Recorded patch/ }).click();
    await row.getByRole('button', { name: 'Copy patch', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
      .toBe(source);
    await page.screenshot({ path: testInfo.outputPath('patch.png') });
    if (valid) {
      const table = row.getByRole('table');
      await expect(table.getByRole('row').filter({ hasText: '-old' })).toHaveText('1-old');
      await expect(table.getByRole('row').filter({ hasText: '+new' })).toHaveText('1+new');
      await expect(row.getByText(/Malformed or unsupported/)).toHaveCount(0);
    } else {
      await expect(row).toContainText('Malformed or unsupported');
      await expect(row.getByRole('table')).toHaveCount(0);
      expect(await row.locator('pre').textContent()).toBe(source);
    }
  });

test('historical patches retain real coordinates, malformed/numbered/large fallback and complete source Copy', async ({
  page,
}) => {
  await open(page);
  const patch =
    '--- a/no-longer-here.ts\n+++ b/no-longer-here.ts\n@@ -41,2 +80,2 @@\n retained\n-old 🌔\n+new 🌔\n';
  const huge = 'x'.repeat(15999) + '🌔' + 'recorded huge source 🌔\n'.repeat(4000);
  await page.evaluate(
    async ({ patch, huge }) => {
      await window.demo.transcript!.record([
        {
          id: 'patches',
          role: 'tool',
          parts: [
            { text: patch, kind: 'patch', role: 'tool', toolName: 'edit', state: 'completed' },
            {
              text: '@@ broken @@\n-old\n+new\n',
              kind: 'patch',
              role: 'tool',
              toolName: 'edit',
              state: 'failed',
            },
            { text: '41 -old\n80 +new\n', kind: 'diff', role: 'tool' },
            { text: huge, kind: 'patch', role: 'tool' },
          ],
        },
      ]);
      await window.demo.application.chat!.jumpToLatest();
    },
    { patch, huge },
  );
  const row = page.locator('[data-transcript-entry="patches"]');
  await expect(row).toContainText('edit · failed');
  await row.getByRole('button', { name: /^Activity/ }).click();
  const first = row.locator('[data-transcript-part="m0.b0"]');
  await first.getByRole('button', { name: /Recorded patch/ }).click();
  const table = first.getByRole('table');
  await expect(table.getByRole('row').filter({ hasText: '-old 🌔' })).toHaveText('42-old 🌔');
  await expect(table.getByRole('row').filter({ hasText: '+new 🌔' })).toHaveText('81+new 🌔');
  await mkdir(output, { recursive: true });
  await first.getByRole('region', { name: 'Recorded unified patch' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'unified-hunks.png') });
  await first.getByRole('button', { name: 'Copy patch', exact: true }).click();
  expect(await page.evaluate(() => window.demo.transcript!.copied.at(-1))).toBe(patch);
  const malformed = row.locator('[data-transcript-part="m0.b1"]');
  await malformed.getByRole('button', { name: /Recorded patch/ }).click();
  await expect(malformed).toContainText('Malformed or unsupported');
  const numbered = row.locator('[data-transcript-part="m0.b2"]');
  await numbered.getByRole('button', { name: /Recorded diff/ }).click();
  await expect(numbered.locator('pre')).toHaveText('41 -old\n80 +new\n');
  const large = row.locator('[data-transcript-part="m0.b3"]');
  await large.getByRole('button', { name: /Recorded patch/ }).click();
  await expect(large).toContainText('Incomplete patch source');
  while (await large.getByRole('button', { name: /Read more/ }).count())
    await large.getByRole('button', { name: /Read more/ }).click();
  await expect(large).toContainText('Large patch');
  await large.getByRole('button', { name: 'Next source', exact: true }).click();
  expect(await large.locator('pre').evaluate((node) => node.textContent!.isWellFormed())).toBe(
    true,
  );
  await expect(large).toContainText('Source 15,999');
  await large.getByRole('button', { name: 'Copy patch', exact: true }).click();
  expect(await page.evaluate(() => window.demo.transcript!.copied.at(-1))).toBe(huge);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'historical-patches.png') });
});
test('no thinking and redaction are honest; stopped partial activity survives without provider signatures', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.activity([{ text: 'Working answer', kind: 'text' }], 'none'),
  );
  await expect(live(page)).toContainText('No thinking supplied');
  await page.evaluate(async () => {
    await window.demo.transcript!.activity(
      [
        { text: '', kind: 'thinking', availability: 'redacted' },
        {
          text: 'published partial',
          kind: 'result',
          role: 'tool',
          toolName: 'bash',
          state: 'interrupted',
        },
        {
          text: '',
          kind: 'result',
          role: 'tool',
          toolName: 'unknown',
          state: 'missing-result',
          availability: 'unavailable',
        },
      ],
      'redacted',
    );
    window.demo.chat.snapshot.state = 'stopped';
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
  });
  const row = live(page);
  await expect(row).toContainText('Stopped');
  await expect(row).toContainText('Thinking · redacted');
  await expect(row).toContainText('interrupted');
  await expect(row).toContainText('missing-result');
  await expect(row).not.toContainText('No thinking supplied');
  await row.getByRole('button', { name: /^Activity/ }).click();
  await row.getByRole('button', { name: /bash.*Output/ }).click();
  await expect(row.locator('pre')).toHaveText('published partial');
  await expect(row.locator('[data-transcript-part="m0.b0"] button')).toHaveCount(1);
});

for (const input of ['pointer', 'Enter', 'Space'] as const)
  test(`Find ${input} collapse persists in the matching Activity until its original range changes`, async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(async () => {
      await window.demo.transcript!.setEntry(
        0,
        ['first NEEDLE\n' + 'x'.repeat(300) + '\nsecond NEEDLE'],
        ['thinking'],
      );
      await window.demo.transcript!.setEntry(1, ['Unrelated thought'], ['thinking']);
    });
    await page.getByRole('region', { name: 'Chat transcript', exact: true }).focus();
    await page.keyboard.press('Control+f');
    const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    await find.fill('needle');
    const row = page.locator('[data-transcript-entry="reading-0"]');
    const activity = row.getByRole('button', { name: /^Activity/ });
    const thought = row.getByRole('button', { name: /^Thinking/ });
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'NEEDLE', entry: 'reading-0' })]);
    if (input === 'pointer') await activity.click();
    else {
      await activity.focus();
      await page.keyboard.press(input === 'Space' ? 'Space' : 'Enter');
    }
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    const active = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.active,
    );
    await page.evaluate(() => {
      const controller = window.demo.application.chat!,
        view = controller.getSnapshot().transcript.view;
      controller.setTranscriptView({
        ...view,
        anchor: { key: 'entry:reading-1', offset: 16 },
      });
      window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
    });
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    const unrelated = page
      .locator('[data-transcript-entry="reading-1"]')
      .getByRole('button', { name: /^Activity/ });
    await expect(unrelated).toHaveAttribute('aria-expanded', 'false');
    expect(
      await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.find.active),
    ).toEqual(active);
    await find.focus();
    await find.press('Enter');
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'NEEDLE', before: 'xxxxxxxx\nsecond ' })]);
    await expect(unrelated).toHaveAttribute('aria-expanded', 'false');
    await expect(find).toBeFocused();
  });
