import { test, expect, type Page, type Locator } from '@playwright/test';
import { Layer, ManagedRuntime } from 'effect';
import type { ChatClient } from '@moonbase/contracts/chat';
import { ChatIpcSession } from '../src/chat/session.ts';
import { browserTranscriptActions, type TranscriptCopy } from '../src/chat/wire.ts';
async function open(page: Page) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      { id: 'before', parts: [{ kind: 'text', text: 'Before work' }] },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
}
async function selectPrefix(page: Page, pre: Locator) {
  await pre.scrollIntoViewIfNeeded();
  const box = await pre.evaluate((element) => {
    element.scrollTop = 0;
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 11);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('SELECT THIS');
}
async function publishOutput(page: Page, text: string, attempt = 0) {
  await page.evaluate(
    async ({ text, attempt }) => {
      await window.demo.transcript!.activity(
        [
          { kind: 'thinking', text: 'Thinking continues', state: 'running' },
          { kind: 'result', role: 'tool', toolName: 'bash', text, state: 'running' },
          { kind: 'details', text: 'detail one' },
          { kind: 'details', text: 'detail two' },
          { kind: 'details', text: 'retained fifth' },
        ],
        'available',
        attempt,
      );
    },
    { text, attempt },
  );
}
async function installCopy(page: Page) {
  const context = await page.evaluate(() => window.demo.chat.dependencies.context);
  const runtime = ManagedRuntime.make(Layer.empty);
  const writes: string[] = [],
    inputs: TranscriptCopy[] = [];
  const client: ChatClient = {
    command: (operation, input) =>
      page.evaluate(
        async ({ operation, input }) =>
          window.demo.chat.dependencies.chat.command(operation, input),
        { operation, input },
      ) as never,
    watch: (_input, callback) => {
      let active = true;
      void page
        .evaluate(() => window.demo.chat.snapshot)
        .then((snapshot) => {
          if (active) callback(snapshot);
        });
      return async () => {
        active = false;
      };
    },
  };
  const owner = new ChatIpcSession(runtime, client, null, context, () => {}, {
    transcript: {
      writeText: async (text) => {
        writes.push(text);
      },
      openExternal: async () => {},
    },
  });
  const actions = browserTranscriptActions(
    {
      context: async () => context,
      call: (kind, operation, input, id) => owner.call(kind, operation, input, id),
      cancel: (id) => owner.cancel(id),
      events: () => () => {},
    },
    'local',
  );
  await page.exposeFunction('copySelectedBody', async (input: TranscriptCopy) => {
    inputs.push(input);
    await actions.copy(input);
  });
  await page.evaluate(() => {
    window.demo.transcript!.native.copy = (input) =>
      (
        window as typeof window & { copySelectedBody(input: TranscriptCopy): Promise<void> }
      ).copySelectedBody(input);
  });
  return {
    writes,
    inputs,
    dispose: async () => {
      await owner.dispose();
      await runtime.dispose();
    },
  };
}
for (const manifest of [false, true])
  test(`independent selected live output retains pointer range manifest=${manifest}`, async ({
    page,
  }, info) => {
    await open(page);
    const update = async (suffix: string) =>
      page.evaluate(async (suffix) => {
        await window.demo.transcript!.activity([
          { kind: 'thinking', text: 'Thinking more' + suffix, state: 'running' },
          {
            kind: 'result',
            role: 'tool',
            toolName: 'bash',
            text: 'SELECT THIS stable prefix\n' + suffix,
            state: 'running',
          },
          { kind: 'details', text: 'detail one' },
          { kind: 'details', text: 'detail two' },
          { kind: 'details', text: 'retained fifth' },
        ]);
      }, suffix);
    await update('first');
    const row = page.locator('[data-transcript-live]');
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
    await row.getByRole('button', { name: /^Activity/ }).click();
    const output = row.locator('[data-transcript-part="m0.b1"]');
    await output.getByRole('button', { name: /Output/ }).click();
    const pre = output.locator('pre');
    await pre.scrollIntoViewIfNeeded();
    const box = await pre.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild!, 0);
      r.setEnd(el.firstChild!, 11);
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('SELECT THIS');
    const before = await page.evaluate(() => ({
      text: window.getSelection()?.toString(),
      focus: document.activeElement?.tagName,
    }));
    await update('first and appended');
    await expect(pre).toBeFocused();
    await expect(row).toContainText('running');
    await page.screenshot({ path: info.outputPath('selected-output.png') });
    const after = await page.evaluate(() => ({
      text: window.getSelection()?.toString(),
      focus: document.activeElement?.tagName,
    }));
    console.log(JSON.stringify({ manifest, before, after, body: await pre.textContent() }));
    expect(after.text).toBe(before.text);
    await expect(pre).toHaveText('SELECT THIS stable prefix\nfirst');
    await output.getByRole('button', { name: 'Copy part', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.demo.transcript!.copied.at(-1)))
      .toBe('SELECT THIS stable prefix\nfirst');
    await pre.click({ position: { x: 8, y: 8 } });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    await expect(pre).toHaveText('SELECT THIS stable prefix\nfirst and appended');
  });
for (const outcome of ['success', 'error'] as const)
  test(`selected loaded output and fixed Copy remain coherent through replacement hydration ${outcome}`, async ({
    page,
  }) => {
    await open(page);
    const native = await installCopy(page);
    const initial = 'SELECT THIS stable prefix\n' + 'retained output 🌔\n'.repeat(80);
    let release: (() => Promise<void>) | undefined;
    try {
      await publishOutput(page, initial);
      const row = page.locator('[data-transcript-live]');
      await row.getByRole('button', { name: 'Load more parts', exact: true }).click();
      await row.getByRole('button', { name: /^Activity/ }).click();
      const output = row.locator('[data-transcript-part="m0.b1"]');
      await output.getByRole('button', { name: /Output/ }).click();
      const pre = output.locator('pre');
      await expect(pre).toHaveText(initial);
      const descriptor = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().snapshot!.run!.transcript!.parts[1]!,
      );
      await selectPrefix(page, pre);
      await page.evaluate(
        ({ bytes, outcome }) => {
          const command = window.demo.chat.dependencies.chat.command;
          const gate = Promise.withResolvers<void>();
          let held = false;
          Object.assign(window, {
            releaseReplacement: () => gate.resolve(),
            replacementHeld: false,
          });
          window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
            if (
              !held &&
              operation === 'getChatTranscriptContent' &&
              'selection' in input &&
              input.selection?.partId === 'm0.b1' &&
              input.selection.bytes !== bytes
            ) {
              held = true;
              const reply = await command(operation, input, options);
              Object.assign(window, { replacementHeld: true });
              await gate.promise;
              if (outcome === 'error') throw Error('Controlled replacement read failure');
              return reply as never;
            }
            return command(operation, input, options) as never;
          };
        },
        { bytes: descriptor.bytes, outcome },
      );
      release = () =>
        page.evaluate(() =>
          (window as typeof window & { releaseReplacement(): void }).releaseReplacement(),
        );
      await publishOutput(page, initial + 'appended current tail\n');
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { replacementHeld: boolean }).replacementHeld,
          ),
        )
        .toBe(true);
      await expect(pre).toHaveText(initial);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('SELECT THIS');
      await pre.click({ position: { x: 8, y: 8 } });
      await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
      await expect(pre).toHaveText(initial);
      await expect(row).toContainText(
        `${new TextEncoder().encode(initial + 'appended current tail\n').length.toLocaleString()} bytes`,
      );
      await output.getByRole('button', { name: 'Copy part', exact: true }).click();
      await expect.poll(() => native.writes).toEqual([initial]);
      expect(native.inputs[0]?.selection).toEqual({
        partId: descriptor.partId,
        bytes: descriptor.bytes,
        revision: descriptor.revision,
      });
      await release();
      if (outcome === 'error') {
        await expect(output.getByRole('alert')).toContainText('Retry content');
        await expect(pre).toHaveText(initial);
        await output.getByRole('button', { name: 'Retry content', exact: true }).click();
      }
      await expect(pre).toHaveText(initial + 'appended current tail\n');
      await output.getByRole('button', { name: 'Copy part', exact: true }).click();
      await expect
        .poll(() => native.writes)
        .toEqual([initial, initial + 'appended current tail\n']);
      const current = await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().snapshot!.run!.transcript!.parts[1]!,
      );
      expect(native.inputs.at(-1)?.selection).toEqual({
        partId: current.partId,
        bytes: current.bytes,
        revision: current.revision,
      });
    } finally {
      await release?.();
      await native.dispose();
    }
  });

for (const change of ['prefix replacement', 'attempt retirement'] as const)
  test(`selected Copy rejects ${change} without writing, then advances after release`, async ({
    page,
  }) => {
    await open(page);
    const native = await installCopy(page);
    try {
      const initial = 'SELECT THIS stable prefix\nfirst';
      await publishOutput(page, initial);
      const row = page.locator('[data-transcript-live]');
      await row.getByRole('button', { name: /^Activity/ }).click();
      const output = row.locator('[data-transcript-part="m0.b1"]');
      await output.getByRole('button', { name: /Output/ }).click();
      const pre = output.locator('pre');
      await selectPrefix(page, pre);
      const originalSource = await row.getAttribute('data-transcript-live');
      const button = output.getByRole('button', { name: 'Copy part', exact: true });
      const currentText =
        change === 'prefix replacement' ? 'REPLACED prefix\nnew output' : initial + ' new attempt';
      await publishOutput(page, currentText, change === 'attempt retirement' ? 1 : 0);
      await expect(pre).toHaveText(initial);
      await button.click();
      await expect(
        page.getByRole('region', { name: 'Chat conversation', exact: true }).getByRole('alert'),
      ).toBeVisible();
      expect(native.writes).toEqual([]);
      expect(native.inputs[0]?.source).toEqual(JSON.parse(originalSource!));
      if (change === 'attempt retirement') {
        await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
        await row.getByRole('button', { name: /^Activity/ }).click();
        await output.getByRole('button', { name: /Output/ }).click();
      } else await pre.click({ position: { x: 8, y: 8 } });
      await expect(pre).toHaveText(currentText);
      await button.click();
      await expect.poll(() => native.writes).toEqual([currentText]);
    } finally {
      await native.dispose();
    }
  });
for (const input of ['pointer', 'Space'] as const)
  test(`Copy ${input} intent retains the displayed selection when it releases before click`, async ({
    page,
  }) => {
    await open(page);
    const native = await installCopy(page);
    try {
      const initial = 'SELECT THIS stable prefix\nfirst';
      await publishOutput(page, initial);
      const row = page.locator('[data-transcript-live]');
      await row.getByRole('button', { name: /^Activity/ }).click();
      const output = row.locator('[data-transcript-part="m0.b1"]');
      await output.getByRole('button', { name: /Output/ }).click();
      const pre = output.locator('pre');
      await selectPrefix(page, pre);
      await publishOutput(page, initial + ' and appended');
      await expect(pre).toHaveText(initial);
      const button = output.getByRole('button', { name: 'Copy part', exact: true });
      if (input === 'pointer') {
        const before = await button.boundingBox();
        await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
        await page.mouse.down();
      } else {
        await button.focus();
        await page.keyboard.down('Space');
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(pre).toHaveText(initial + ' and appended');
      if (input === 'pointer') {
        const after = await button.boundingBox();
        await page.mouse.move(after!.x + after!.width / 2, after!.y + after!.height / 2);
        await page.mouse.up();
      } else await page.keyboard.up('Space');
      await expect.poll(() => native.writes).toEqual([initial]);
      expect(native.inputs[0]?.selection?.bytes).toBe(new TextEncoder().encode(initial).length);
    } finally {
      await native.dispose();
    }
  });
test('held Copy intent does not migrate to a new source after navigation', async ({ page }) => {
  await open(page);
  const native = await installCopy(page);
  try {
    const initial = 'SELECT THIS stable prefix\nfirst';
    await publishOutput(page, initial);
    const row = page.locator('[data-transcript-live]');
    await row.getByRole('button', { name: /^Activity/ }).click();
    const output = row.locator('[data-transcript-part="m0.b1"]');
    await output.getByRole('button', { name: /Output/ }).click();
    await selectPrefix(page, output.locator('pre'));
    const button = output.getByRole('button', { name: 'Copy part', exact: true });
    const before = await button.boundingBox();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await publishOutput(page, initial + ' new source', 1);
    await page.evaluate(async () => {
      window.getSelection()?.removeAllRanges();
      (document.activeElement as HTMLElement).blur();
      const controller = window.demo.application.chat!;
      await controller.jumpToLatest();
      const transcript = controller.getSnapshot().snapshot!.run!.transcript!;
      if (transcript.source.kind !== 'live') throw Error('Expected live source');
      controller.setTranscriptView({
        anchor: { key: `live:${transcript.source.submissionId}`, offset: 16 },
        expanded: [],
      });
    });
    // The new attempt's disclosures start folded; the keyboard opens them while the press is held.
    await row.getByRole('button', { name: /^Activity/ }).press('Enter');
    await output.getByRole('button', { name: /Output/ }).press('Enter');
    await expect(output.locator('pre')).toHaveText(initial + ' new source');
    const after = await button.boundingBox();
    await page.mouse.move(after!.x + after!.width / 2, after!.y + after!.height / 2);
    await page.mouse.up();
    await expect(
      page.getByRole('region', { name: 'Chat conversation', exact: true }).getByRole('alert'),
    ).toContainText('displayed output changed');
    expect(native.inputs).toEqual([]);
    expect(native.writes).toEqual([]);
    await button.click();
    await expect.poll(() => native.writes).toEqual([initial + ' new source']);
  } finally {
    await native.dispose();
  }
});
test('released output retention yields to the existing 128-selection content bound', async ({
  page,
}) => {
  await open(page);
  const initial = 'SELECT THIS stable prefix\n' + 'retained output line\n'.repeat(60);
  const update = (text: string) =>
    page.evaluate(async (text) => {
      await window.demo.transcript!.activity([
        { kind: 'result', role: 'tool', toolName: 'bash', text, state: 'running' },
        ...Array.from({ length: 129 }, (_, index) => ({
          kind: 'details' as const,
          text: `pressure ${index}`,
        })),
      ]);
    }, text);
  await update(initial);
  await page.evaluate(async () => {
    const controller = window.demo.application.chat!;
    const source = controller.getSnapshot().snapshot!.run!.transcript!.source;
    for (let index = 0; index < 40; index++) {
      await controller.loadTranscriptManifest(source);
      if (controller.getSnapshot().transcript.manifest?.status === 'complete') break;
    }
  });
  const row = page.locator('[data-transcript-live]');
  await row.getByRole('button', { name: /^Activity/ }).click();
  const pre = row.locator('[data-transcript-part="m0.b0"] pre');
  await row
    .locator('[data-transcript-part="m0.b0"]')
    .getByRole('button', { name: /Output/ })
    .click();
  await expect(pre).toHaveText(initial);
  await selectPrefix(page, pre);
  const oldRevision = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().snapshot!.run!.transcript!.parts[0]!.revision,
  );
  await page.evaluate(() => {
    const command = window.demo.chat.dependencies.chat.command;
    const gate = Promise.withResolvers<void>();
    let held = false;
    Object.assign(window, { releaseBoundedRead: () => gate.resolve(), boundedReadHeld: false });
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      if (
        !held &&
        operation === 'getChatTranscriptContent' &&
        'selection' in input &&
        input.selection?.partId === 'm0.b0'
      ) {
        held = true;
        const reply = await command(operation, input, options);
        Object.assign(window, { boundedReadHeld: true });
        await gate.promise;
        return reply as never;
      }
      return command(operation, input, options) as never;
    };
  });
  try {
    await update(initial + 'appended');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { boundedReadHeld: boolean }).boundedReadHeld,
        ),
      )
      .toBe(true);
    await page.evaluate(async () => {
      const controller = window.demo.application.chat!;
      const manifest = controller.getSnapshot().transcript.manifest!;
      for (const part of manifest.parts.filter((part) => part.kind === 'details'))
        await controller.loadTranscriptPart(manifest.source, {
          partId: part.partId,
          bytes: part.bytes,
          revision: part.revision,
        });
    });
    expect(
      await page.evaluate((oldRevision) => {
        const content = window.demo.application.chat!.getSnapshot().transcript.content;
        return [
          content.length <= 128,
          content.some((item) => item.selection.revision === oldRevision),
        ];
      }, oldRevision),
    ).toEqual([true, false]);
    await expect(pre).toHaveText(initial);
    await pre.click({ position: { x: 8, y: 8 } });
    await expect(pre).toHaveText([...initial].slice(0, 64).join(''));
  } finally {
    await page.evaluate(() =>
      (window as typeof window & { releaseBoundedRead(): void }).releaseBoundedRead(),
    );
  }
  await expect(pre).toHaveText(initial + 'appended');
});
for (const manifest of [false, true])
  test(`independent actual pointer selection in loaded live body survives append with reread held manifest=${manifest}`, async ({
    page,
  }, info) => {
    await open(page);
    const initial =
      'SELECT THIS stable prefix\n' +
      Array.from({ length: 60 }, (_, i) => `retained output line ${i}\n`).join('');
    const update = async (text: string) =>
      page.evaluate(async (text) => {
        await window.demo.transcript!.activity([
          { kind: 'text', text: 'Before' },
          { kind: 'result', role: 'tool', toolName: 'bash', text, state: 'running' },
          { kind: 'details', text: 'detail one' },
          { kind: 'details', text: 'detail two' },
          { kind: 'details', text: 'retained fifth' },
        ]);
      }, text);
    await update(initial);
    const row = page.locator('[data-transcript-live]');
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
    await row.getByRole('button', { name: /^Activity/ }).click();
    const output = row.locator('[data-transcript-part="m0.b1"]');
    await output.getByRole('button', { name: /Output/ }).click();
    const pre = output.locator('pre');
    await expect(pre).toHaveText(initial);
    await pre.scrollIntoViewIfNeeded();
    await pre.evaluate((el) => {
      el.scrollTop = 0;
      el.setAttribute('data-independent-before', 'true');
    });
    const box = await pre.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild!, 0);
      r.setEnd(el.firstChild!, 11);
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.screenshot({ path: info.outputPath('before-append-selection.png') });
    const before = await page.evaluate(() => window.getSelection()!.toString());
    expect(before).toBe('SELECT THIS');
    await expect(pre).toBeFocused();
    await page.evaluate(() => {
      const command = window.demo.chat.dependencies.chat.command;
      const gate = Promise.withResolvers<void>();
      Object.assign(window, { r10Release: () => gate.resolve(), r10Held: false });
      window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
        if (
          operation === 'getChatTranscriptContent' &&
          'selection' in input &&
          input.selection?.partId === 'm0.b1'
        ) {
          const reply = await command(operation, input, options);
          Object.assign(window, { r10Held: true });
          await gate.promise;
          return reply as never;
        }
        return command(operation, input, options) as never;
      };
    });
    try {
      await update(initial + 'new appended tail\n');
      await expect
        .poll(() => page.evaluate(() => (window as typeof window & { r10Held: boolean }).r10Held))
        .toBe(true);
      await expect(pre).toBeFocused();
      const during = await page.evaluate(() => ({
        selected: window.getSelection()!.toString(),
        focus: document.activeElement?.tagName,
        text: document.querySelector('[data-independent-before]')?.textContent,
      }));
      console.log(JSON.stringify({ manifest, before, during, initialLength: initial.length }));
      await page.screenshot({ path: info.outputPath('held-reread-selection.png') });
      expect.soft(during.selected).toBe(before);
      expect.soft(during.text).toContain('retained output line 59');
    } finally {
      await page.evaluate(() => (window as typeof window & { r10Release(): void }).r10Release());
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.demo.application.chat!.getSnapshot();
          const part = state.snapshot!.run!.transcript!.parts[1]!;
          return state.transcript.content.find(
            (content) => content.selection.revision === part.revision,
          )?.status;
        }),
      )
      .toBe('complete');
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(before);
    await expect(pre).toHaveText(initial);
    await pre.click({ position: { x: 8, y: 8 } });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    await expect(pre).toHaveText(initial + 'new appended tail\n');
  });
