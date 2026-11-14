import {
  openActivity,
  openActivityGroups,
  scrollToEnd,
  scrollToStart,
  stepToggle,
  transcriptList,
} from '../fixtures/transcript-list.ts';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFindHighlight } from '../fixtures/find-highlight.ts';

async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
}
const live = (page: Page) => page.locator('[data-transcript-live]');
for (const source of ['durable', 'live'] as const)
  test(`${source} failed result keeps originating call evidence through a held and failed first manifest read`, async ({
    page,
  }) => {
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
    await expect(origin).toContainText('Read failed.txt · failed');
    await openActivityGroups(page);
    await result.getByRole('button', { name: 'Load more parts', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const manifest = window.demo.application.chat!.getSnapshot().transcript.manifest;
          return [manifest?.status, manifest?.parts.length];
        }),
      )
      .toEqual(['loading', 0]);
    // The output row draws no step of its own; its call's headline carries the failure.
    await expect(
      result.locator('[data-transcript-step]').filter({ hasText: 'Partial failed' }),
    ).toHaveCount(0);
    await expect.soft(origin).toContainText('Read failed.txt · failed');
    await page.evaluate(() =>
      (window as typeof window & { releaseEvidenceManifest(): void }).releaseEvidenceManifest(),
    );
    await expect(result.getByRole('alert')).toContainText('Retry parts');
    await expect(
      result.locator('[data-transcript-step]').filter({ hasText: 'Partial failed' }),
    ).toHaveCount(0);
    await expect(origin).toContainText('Read failed.txt · failed');
    // Opening the call's card opens its output beneath it, retained failure and all.
    await openActivity(origin);
    await expect(result.getByText('Partial failed output retained')).toBeVisible();
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
  // A saved call whose result isn't among the rows read isn't still running: its result isn't shown.
  const pending = other.locator('[data-transcript-step] > [data-glyph]', {
    hasText: 'second.ts',
  });
  await expect(pending).toHaveText('Read second.ts · no result shown');
  await expect(pending).toHaveAttribute('data-glyph', '○');
  await expect(other).not.toContainText('failed');
  // Rows unmount while scrolled away, so the newest row is read before scrolling to the start.
  const ambiguous = page.locator('[data-transcript-entry="ambiguous"]');
  await expect(ambiguous).toContainText('Read a file · interrupted');
  await expect(ambiguous.locator('[data-transcript-step] > [data-glyph]')).not.toContainText(
    'ambiguous',
  );
  await scrollToStart(page);
  const origin = page.locator('[data-transcript-entry="origin"]');
  await expect(origin).toContainText('Read first.ts · failed');
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
  // Folded, each step shows only its line; opening them shows every recorded part, labelled.
  await expect(
    row.locator('[data-transcript-part] pre').filter({ hasText: 'Available thought' }),
  ).toBeHidden();
  await openActivity(row);
  // Inside a step, a part's label is its kind and any unusual state; the step's line names the tool.
  for (const [name, count] of [
    [/^Thinking$/, 1],
    [/^Arguments · requested$/, 2],
    [/^Arguments as run · interrupted$/, 1],
    [/^Output · interrupted$/, 1],
    [/^Details$/, 1],
  ] as const) {
    const labels = row.locator('[data-transcript-part]').getByText(name);
    await expect(labels).toHaveCount(count);
    for (const label of await labels.all()) await expect(label).toBeVisible();
  }
  await expect(row.locator('pre').getByText('Available thought', { exact: true })).toBeVisible();
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
  for (const [, width, height] of [
    ['normal', 1440, 900],
    ['compact', 540, 844],
    ['zoom-200', 720, 450],
  ] as const) {
    await page.setViewportSize({ width, height });
    await row.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
for (const manifest of [false, true])
  for (const focus of [false, true])
    test(`same-source thinking/tool appends after loaded manifest=${manifest} focus=${focus}`, async ({
      page,
    }) => {
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
      await openActivityGroups(page);
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
      await openActivity(row);
      // The output opens with its call, recorded in an earlier row.
      await openActivity(page.locator('[data-transcript-entry="stream-origin"]'));
      const group = stepToggle(row, 'm0.b1');
      const thought = row.locator('[data-transcript-part="m0.b1"]');
      const output = row.locator('[data-transcript-part="m0.b2"]');
      // Opening the card shows its parts; none folds on its own.
      const tail = row.locator('[data-transcript-part="m0.b4"]');
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
          .soft(row.locator('[data-transcript-step] > [data-glyph]').first())
          .toHaveText(`Thought ${suffix}`, { timeout: 1500 });
        if (focus) await expect(output.locator('pre')).toBeFocused();
        await expect(group).toHaveAttribute('aria-expanded', 'true');
      }
      expect(await reads()).toBe(beforeReads);
      if (manifest)
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Detail B');
      await expect
        .soft(page.locator('[data-transcript-entry="stream-origin"]'))
        .toContainText('Ran stream moon · failed', { timeout: 1500 });
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
    await openActivity(row);
    const thought = row.locator('[data-transcript-part="m0.b1"]');
    const output = row.locator('[data-transcript-part="m0.b2"]');
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
    group = stepToggle(row, 'm0.b1');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toContainText('Running printf moon');
  await openActivity(row);
  const thought = row.locator('[data-transcript-part="m0.b1"]');
  const result = row.locator('[data-transcript-part="m0.b3"]');
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
  await openActivity(live(page));
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
  await openActivity(live(page));
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
  await openActivity(row);
  await expect(row.locator('pre')).toHaveText('Current held output');
});
/** A completed `bash` call recorded as its own entry, as Pi records each tool call. */
const bashCall = (id: string, command: string, state = 'completed') => ({
  id,
  parts: [
    {
      kind: 'arguments' as const,
      partId: 'call',
      toolName: 'bash',
      state: state as 'completed',
      text: JSON.stringify({ command }),
    },
  ],
});
/** A running output of the `origin` call, recorded in a later row. */
const originOutput = (text: string) => ({
  kind: 'result' as const,
  role: 'tool' as const,
  toolName: 'bash',
  state: 'running' as const,
  pairing: 'matched' as const,
  call: { entryId: 'origin', partId: 'call' },
  text,
});
/** Marks a row's DOM; remounting the row would drop the mark. */
const mark = (row: Locator) => row.evaluate((node) => Object.assign(node, { rowMark: true }));
const isMarked = (row: Locator) => row.evaluate((node) => 'rowMark' in node);
/** The space between a row's drawn content and the next row's. */
const readGap = (above: Locator, below: Locator) =>
  Promise.all([
    above.locator('[data-transcript-activity]').boundingBox(),
    below.locator('article').boundingBox(),
  ]).then(([a, b]) => b!.y - (a!.y + a!.height));
const readAnchor = (page: Page) =>
  page.evaluate(() => {
    const { view, atLatest } = window.demo.application.chat!.getSnapshot().transcript;
    return { key: view.anchor?.key, atLatest };
  });
test('an activity card stays mounted as the live response joins it, the live response as it leaves, and a reader in either anchors to a stored row', async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  // Enough earlier calls in the card that it is taller than the viewport.
  await page.evaluate(
    async ([calls, last]) => {
      await window.demo.transcript!.record([
        { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
        ...calls,
        last,
      ]);
      await window.demo.application.chat!.jumpToLatest();
    },
    [
      Array.from({ length: 60 }, (_, index) => bashCall(`step-${index}`, `step ${index}`)),
      bashCall('origin', 'check', 'running'),
    ] as const,
  );
  const origin = page.locator('[data-transcript-row="entry:origin"]');
  // The calls fold into one run; open it so the rows show.
  await openActivityGroups(page);
  await expect(origin).toContainText('Running check');
  // The list mounts rows afresh while it first lays the dataset out; mark once that settles.
  await expect
    .poll(async () => {
      await mark(origin);
      await page.waitForTimeout(1000);
      return isMarked(origin);
    })
    .toBe(true);
  // The call's output arrives in the live response, which joins the card's end.
  await page.evaluate(
    (part) => window.demo.transcript!.activity([part], 'none'),
    originOutput('Check output'),
  );
  const row = page.locator('[data-transcript-row^="live:"]');
  await expect(row).toBeAttached();
  await mark(row);
  expect(await isMarked(origin)).toBe(true);
  await expect.poll(async () => Math.abs(await readGap(origin, row))).toBeLessThan(1);
  // The live row holds only the call's output, so it has no chevron (or hidden control) of its own.
  await expect(row.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
  await origin.getByRole('button', { name: /^Activity/ }).click();
  await expect(row.locator('pre')).toHaveText('Check output');
  // The answer starts, so the live row leaves the card and keeps its item: the running response
  // stays mounted, and the card's stored rows move to an item of their own, still open.
  const answer = (text: string) =>
    page.evaluate(
      ([part, text]) => window.demo.transcript!.activity([part, { kind: 'text', text }], 'none'),
      [originOutput('Check output'), text] as const,
    );
  await answer('All checks pass.');
  await expect(row).toContainText('All checks pass.');
  expect(await isMarked(row)).toBe(true);
  await expect(origin.getByRole('button', { name: /^Activity/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // Separate items, so a gap (joined rows have none); the run pulls its answer up to read as
  // the answer's heading, so the gap is small.
  await expect.poll(() => readGap(origin, row)).toBeGreaterThan(2);
  // Reading the card saves a stored row: the reader isn't following the live edge.
  await scrollToEnd(page);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() => readAnchor(page))
    .toEqual({ key: expect.stringMatching(/^entry:step-/), atLatest: false });
  // A reader inside the live response anchors to the stored row above it.
  await answer('All checks pass.\n\n' + 'Detail.\n\n'.repeat(400));
  await expect(row).toContainText('Detail.');
  await scrollToEnd(page);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await page.mouse.wheel(0, -300);
  await expect.poll(() => readAnchor(page)).toEqual({ key: 'entry:origin', atLatest: false });
});

test('a reader scrolled up into the card stays put, and the card stays mounted, as the answer starts', async ({
  page,
}) => {
  test.setTimeout(90000);
  await open(page);
  await page.evaluate(
    async ([calls, last]) => {
      await window.demo.transcript!.record([
        { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
        ...calls,
        last,
      ]);
      await window.demo.application.chat!.jumpToLatest();
    },
    [
      Array.from({ length: 60 }, (_, index) => bashCall(`step-${index}`, `step ${index}`)),
      bashCall('origin', 'check', 'running'),
    ] as const,
  );
  const origin = page.locator('[data-transcript-row="entry:origin"]');
  // The calls fold into one run; open it so the rows show.
  await openActivityGroups(page);
  await expect(origin).toContainText('Running check');
  await page.evaluate(
    (part) => window.demo.transcript!.activity([part], 'none'),
    originOutput('Check output'),
  );
  await expect(page.locator('[data-transcript-row^="live:"]')).toBeAttached();
  // The reader scrolls up into the card, away from the live edge.
  await scrollToEnd(page);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => readAnchor(page)).toMatchObject({ atLatest: false });
  const step = page.locator('[data-transcript-row="entry:step-50"]');
  const readTop = () =>
    step.evaluate(
      (node) =>
        node.getBoundingClientRect().top -
        node.closest('[aria-label="Chat transcript"]')!.getBoundingClientRect().top,
    );
  await expect
    .poll(async () => {
      await mark(step);
      await page.waitForTimeout(500);
      return isMarked(step);
    })
    .toBe(true);
  const before = await readTop();
  await page.evaluate(
    (part) =>
      window.demo.transcript!.activity(
        [part, { kind: 'text', text: 'All checks pass.\n\n' + 'Detail.\n\n'.repeat(40) }],
        'none',
      ),
    originOutput('Check output'),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const last = window.demo.application.chat!.getSnapshot().transcript.rows.at(-1)!;
        return last.kind === 'live' ? last.entry.text.slice(0, 16) : null;
      }),
    )
    .toBe('All checks pass.');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(await isMarked(step)).toBe(true);
  expect(Math.abs((await readTop()) - before)).toBeLessThan(1.5);
});

test("an output whose call isn't retained reads as its own step with a chevron", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
      {
        id: 'result',
        role: 'tool',
        parts: [
          {
            kind: 'result',
            role: 'tool',
            toolName: 'bash',
            state: 'completed',
            pairing: 'matched',
            // The call's entry is older than the retained history.
            call: { entryId: 'evicted-origin', partId: 'call' },
            text: 'Orphaned output',
          },
        ],
      },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
  const result = page.locator('[data-transcript-row="entry:result"]');
  await expect(result.locator('[data-transcript-step] > [data-glyph]')).toContainText(
    'Ran a command',
  );
  const toggle = result.getByRole('button', { name: /^Activity/ });
  await toggle.click();
  await expect(result.locator('pre')).toHaveText('Orphaned output');
});

test("Find revealing a match in a call's output shows the call's card open, and folding the call folds it", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async (output) => {
    await window.demo.transcript!.record([
      { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
      {
        id: 'origin',
        parts: [
          {
            kind: 'arguments',
            partId: 'call',
            toolName: 'bash',
            state: 'completed',
            text: '{"command":"check"}',
          },
        ],
      },
      { id: 'result', role: 'tool', parts: [{ ...output, state: 'completed' }] },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  }, originOutput('Found the NEEDLE here'));
  const origin = page.locator('[data-transcript-row="entry:origin"]'),
    result = page.locator('[data-transcript-row="entry:result"]');
  const chevron = origin.getByRole('button', { name: /^Activity/ });
  await expect(chevron).toHaveAttribute('aria-expanded', 'false');
  await expect(result.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
  await page.getByRole('region', { name: 'Chat transcript', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('textbox', { name: 'Find in conversation', exact: true }).fill('needle');
  await expect(result.locator('pre')).toBeVisible();
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: 'NEEDLE', entry: 'result' })]);
  // The call's card shows the output it opened, and its chevron folds it.
  await expect(chevron).toHaveAttribute('aria-expanded', 'true');
  await chevron.click();
  await expect(chevron).toHaveAttribute('aria-expanded', 'false');
  await expect(result.locator('pre')).toBeHidden();
  // The chevron opens the call and its output again.
  await chevron.click();
  await expect(chevron).toHaveAttribute('aria-expanded', 'true');
  await expect(result.locator('pre')).toBeVisible();
});
for (const valid of [false, true])
  test(`EOF patch source without terminal newline stays exact in Copy: ${valid ? 'valid replacement' : 'truncated replacement'}`, async ({
    page,
  }) => {
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
    await openActivity(row);
    await row.getByRole('button', { name: 'Copy patch', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
      .toBe(source);
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
  await expect(row.locator('[data-transcript-step] > [data-glyph="✕"]')).toContainText('· failed');
  await openActivity(row);
  const first = row.locator('[data-transcript-part="m0.b0"]');
  const table = first.getByRole('table');
  await expect(table.getByRole('row').filter({ hasText: '-old 🌔' })).toHaveText('42-old 🌔');
  await expect(table.getByRole('row').filter({ hasText: '+new 🌔' })).toHaveText('81+new 🌔');
  await first.getByRole('region', { name: 'Recorded unified patch' }).scrollIntoViewIfNeeded();
  await first.getByRole('button', { name: 'Copy patch', exact: true }).click();
  expect(await page.evaluate(() => window.demo.transcript!.copied.at(-1))).toBe(patch);
  const malformed = row.locator('[data-transcript-part="m0.b1"]');
  await expect(malformed).toContainText('Malformed or unsupported');
  const numbered = row.locator('[data-transcript-part="m0.b2"]');
  await expect(numbered.locator('pre')).toHaveText('41 -old\n80 +new\n');
  const large = row.locator('[data-transcript-part="m0.b3"]');
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
});
test('a running response shows no status notes; redaction is honest; stopped partial activity survives without provider signatures', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.demo.transcript!.activity([{ text: 'Working answer', kind: 'text' }], 'none'),
  );
  await expect(live(page)).toContainText('Working answer');
  // The activity shows a run is going, so neither the row nor the page repeats it.
  await expect(live(page)).not.toContainText(/running|thinking/i);
  await expect(page.getByRole('status', { name: 'Conversation status' })).toHaveCount(0);
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
  await expect(page.getByRole('status', { name: 'Conversation status' })).toHaveText('Stopped');
  await expect(row).toContainText('Thought redacted');
  await expect(row).toContainText('interrupted');
  await expect(row).toContainText('no result');
  await openActivity(row);
  await expect(row.locator('pre')).toHaveText('published partial');
  // Redacted thinking has no content to copy, and parts in a card have no fold of their own.
  await expect(row.locator('[data-transcript-part="m0.b0"] button')).toHaveCount(0);
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
    // The thought shows whenever its card is open; it has no fold of its own.
    const thought = row.locator('[data-transcript-part] pre').first();
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await expect(thought).toBeVisible();
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
    await expect(thought).toBeVisible();
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'NEEDLE', before: 'xxxxxxxx\nsecond ' })]);
    await expect(unrelated).toHaveAttribute('aria-expanded', 'false');
    await expect(find).toBeFocused();
  });

const answers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `answer-${index}`,
    parts: [{ kind: 'text' as const, text: `Answer ${index}\n\n` + 'words '.repeat(60) }],
  }));
const runTop = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector('[data-transcript-list]')!.getBoundingClientRect();
    const line = document.querySelector('[data-transcript-activity-group]')!;
    return line.getBoundingClientRect().top - list.top;
  });

test('a folded run stays folded as the reader scrolls it to the top, and is restored there', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(
    async ([calls, rest]) => {
      await window.demo.transcript!.record([
        { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
        ...calls,
        ...rest,
      ]);
      // The run's first row: where a folded run's own place is, so it stays folded.
      await window.demo.application.chat!.jumpToEntry('run-0');
    },
    [
      Array.from({ length: 6 }, (_, index) => bashCall(`run-${index}`, `step ${index}`)),
      answers(30),
    ] as const,
  );
  const fold = page.locator('[data-transcript-activity-group]');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  // The reader scrolls a few pixels past the run's line.
  await transcriptList(page).hover();
  await page.mouse.wheel(0, 4);
  // The place saved is the run's first row: its other rows aren't shown.
  await expect.poll(() => readAnchor(page)).toEqual({ key: 'entry:run-0', atLatest: false });
  await page.waitForTimeout(500);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-transcript-row="entry:run-3"]')).toBeHidden();
  const before = await runTop(page);
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).locator('..').hover();
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => Math.abs((await runTop(page)) - before)).toBeLessThan(1.5);
});

test('a folded run opens for a Find match in it, folds again for that match, and reopens when Find moves to its next match', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(
    async ([run, output, rest]) => {
      await window.demo.transcript!.record([
        { id: 'question', role: 'user', parts: [{ kind: 'text', role: 'user', text: 'Run it' }] },
        run[0]!,
        run[1]!,
        { id: 'result', role: 'tool', parts: [{ ...output, state: 'completed' }] },
        run[2]!,
        ...rest,
      ]);
      await window.demo.application.chat!.jumpToLatest();
    },
    [
      [bashCall('run-0', 'ls'), bashCall('origin', 'check'), bashCall('run-2', 'pwd')],
      originOutput('first NEEDLE and second NEEDLE'),
      answers(3),
    ] as const,
  );
  const fold = page.locator('[data-transcript-activity-group]');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await transcriptList(page).focus();
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await find.fill('needle');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-transcript-row="entry:result"] pre')).toBeVisible();
  // The reader folds the run while its match is active; it stays folded.
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(300);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  // Find moving to the next match in the run opens it again.
  await find.focus();
  await find.press('Enter');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
});

test('a thought shows while the reply works and gives way to its text; an empty thought never shows', async ({
  page,
}) => {
  await open(page);
  const thought = {
    kind: 'thinking',
    text: '**Checking the newline rules**\n\nPOSIX says so.',
  } as const;
  const update = (parts: { kind: 'thinking' | 'text'; text: string }[]) =>
    page.evaluate(async (parts) => {
      await window.demo.transcript!.activity(
        parts.map((part, index) => ({ ...part, partId: `m0.b${index}` })),
      );
      await window.demo.application.chat!.jumpToLatest();
    }, parts);
  const row = live(page);
  // Only a thought with nothing to read: the reply is working, with no step to name.
  await update([{ kind: 'thinking', text: '' }]);
  await expect(page.locator('[data-transcript-activity-group]')).toHaveText(/Working/);
  await expect(row.locator('[data-transcript-step]')).toHaveCount(0);
  // A thought to read names what the reply is doing, under its working line.
  await update([{ kind: 'thinking', text: '' }, thought]);
  await expect(page.getByText('Checking the newline rules', { exact: true }).first()).toBeVisible();
  // Its text takes the thought's place.
  await update([{ kind: 'thinking', text: '' }, thought, { kind: 'text', text: 'Yes, end it.' }]);
  await expect(row.getByText('Yes, end it.', { exact: true })).toBeVisible();
  await expect(page.getByText('Checking the newline rules', { exact: true })).toHaveCount(0);
  await expect(row.locator('[data-transcript-step]')).toHaveCount(0);
  // Saved, the reply reads the same.
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      {
        id: 'answered',
        thinking: 'available',
        parts: [
          { kind: 'thinking', text: '' },
          { kind: 'thinking', text: 'Checking the newline rules' },
          { kind: 'text', text: 'Yes, end it.' },
        ],
      },
    ]);
  });
  const saved = page.locator('[data-transcript-entry="answered"]');
  await expect(saved.getByText('Yes, end it.', { exact: true })).toBeVisible();
  await expect(saved.locator('[data-transcript-step]')).toHaveCount(0);
  await expect(saved).not.toContainText('Thought');
});
