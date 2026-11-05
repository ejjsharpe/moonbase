import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const output = resolve('../../test-results/transcript-112');
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
}
const live = (page: Page) => page.locator('[data-transcript-live]');
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
  await page.getByRole('button', { name: 'Load earlier', exact: true }).click();
  const origin = page.locator('[data-transcript-entry="origin"]');
  await expect(origin).toContainText('read · first.ts · failed');
  await expect(origin.getByText('Before the call', { exact: true })).toBeVisible();
  await expect(origin.getByText('After the call', { exact: true })).toBeVisible();
  expect(
    await origin
      .locator('[data-transcript-part]')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-transcript-part'))),
  ).toEqual(['m0.b0', 'call', 'm0.b2']);
  await expect(page.locator('[data-transcript-entry="ambiguous"]')).toContainText(
    'interrupted · ambiguous',
  );
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
test('thinking/tool progress changes before completion with stable focus and expansion; group collapse survives a retained part anchor', async ({
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
  await page.evaluate(() => {
    const controller = window.demo.application.chat!,
      summary = controller.getSnapshot().snapshot!.run!.transcript!,
      part = summary.parts[1]!;
    if (summary.source.kind !== 'live') throw Error();
    controller.setTranscriptView({
      anchor: {
        backendId: controller.backendId,
        source: summary.source,
        partId: part.partId,
        bytes: part.bytes,
        revision: part.revision,
        offset: 16,
      },
      expanded: [],
    });
  });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await group.click();
  await update('Thinking first and next again', 'Output first and next again');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(thought.locator('pre')).not.toBeVisible();
  await row.getByRole('button', { name: 'Load more parts' }).click();
  await expect(row.getByText('Authored before', { exact: true })).toBeVisible();
  await expect(row.getByText('Authored after', { exact: true })).toBeVisible();
});
test('generic part navigation reveals the containing activity and preserves explicit durable group collapse', async ({
  page,
}) => {
  await open(page);
  const row = page.locator('[data-transcript-entry="reading-179"]');
  await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: { entryId: 'reading-179', partId: 'm0.b2', offset: 16 },
      expanded: [],
    });
  });
  const group = row.getByRole('button', { name: /^Activity/ });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByRole('region', { name: 'Recorded unified patch' })).toBeVisible();
  await group.click();
  await page.evaluate(() =>
    window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot)),
  );
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: { entryId: 'reading-179', partId: 'm0.b3', offset: 16 },
      expanded: controller.getSnapshot().transcript.view.expanded,
    });
  });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByText(/Recorded numbered diff fallback/)).toBeVisible();
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
      anchor: { entryId: 'recent', offset: 0 },
      expanded: [],
    });
  });
  const row = live(page);
  await expect(row).toContainText('Current held output');
  await row.getByRole('button', { name: /^Activity/ }).click();
  await row.getByRole('button', { name: /Output/ }).click();
  await expect(row.locator('pre')).toHaveText('Current held output');
  expect(
    await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.atLatest),
  ).toBe(false);
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
