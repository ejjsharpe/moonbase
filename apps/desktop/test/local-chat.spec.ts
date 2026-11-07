import assert from 'node:assert/strict';
import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { controlledHostFixture } from '../../../tests/chat/fixture.ts';
import {
  closeSettings,
  createRemoteChat,
  disconnectChat,
  openSettings,
  selectRemoteChat,
  showChat,
} from './chat-target.ts';
import { captureNative } from './editor-regressions.ts';
import { retainedImage } from './stored-image-fixture.ts';

let fixtureDirectory: string;
test.afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});
test.beforeAll(async () => {
  await mkdir(resolve('../../test-results/transcript-111'), { recursive: true });
  await mkdir(resolve('../../test-results/transcript-112'), { recursive: true });
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-ui-')));
  for (const name of ['renderer', 'workspace', 'preload.cjs'])
    await symlink(resolve('dist', name), join(fixtureDirectory, name));
  await build({
    entryPoints: [resolve('src/main.ts')],
    outfile: join(fixtureDirectory, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as moonbaseRequire } from 'node:module';const require=moonbaseRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'controlled-local-model',
        setup(builder) {
          builder.onLoad({ filter: /pi-runtime\/src\/index\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            return {
              loader: 'ts',
              contents:
                "import { defineExtension, defineTool } from '@earendil-works/pi-durable'; import { Type } from 'typebox';\n" +
                source
                  .replace(
                    '      if (!config.registry) registry.install(CodingTools);',
                    `      if (!config.registry) registry.install(CodingTools);
      if (process.env.MOONBASE_TEST_ACTIVITY) registry.install(defineExtension({ name: 'held-local-activity', tools: [defineTool({
        name: 'controlled_activity', description: 'Controlled held output; no filesystem access', parameters: Type.Object({}),
        execute: async (_input, api, ctx) => {
          const control = globalThis.localActivity ??= {};
          api.output('First local tool chunk');
          control.next = () => api.output(' and next update');
          await new Promise(resolve => { control.release = resolve; if (ctx.abortSignal.aborted) resolve(); else ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true }); });
          return { output: [{ type: 'text', text: 'Local tool completed' }, ...(process.env.MOONBASE_TEST_IMAGES ? [{ type: 'image', data: process.env.MOONBASE_TEST_IMAGES, mimeType: 'image/png' }] : [])] };
        }
      })] }));`,
                  )
                  .replace(
                    "    getChat: (d) => host.run('getChat', d, (input) => host.snapshot(input.target)),",
                    "    getChat: (d) => { (globalThis.activityReads ??= []).push('getChat'); return host.run('getChat', d, (input) => host.snapshot(input.target)); },",
                  ),
            };
          });
          builder.onLoad({ filter: /desktop\/src\/main\/chat-backends\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            const marker = '  let local = localResult.backend;';
            assert(source.includes(marker), 'Local activity fixture injection point is missing');
            return {
              loader: 'ts',
              contents:
                "import { Effect } from 'effect';\n" +
                source.replace(
                  marker,
                  "  let local = localResult.backend; if (local && process.env.MOONBASE_TEST_LOCAL_ACTIVE) local.control.hasActiveWork = () => Effect.succeed(true); if (local && process.env.MOONBASE_TEST_LOCAL_SCAN_ERROR) local.control.hasActiveWork = () => Effect.fail(new ApplicationError({ code: 'Persistence', message: 'Controlled activity scan failure' }));",
                ),
            };
          });
          builder.onLoad({ filter: /pi-runtime\/src\/local-models\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            return {
              loader: 'ts',
              contents:
                `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';\nimport { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';\n` +
                source.replace(
                  '  return models;',
                  `
          const original = models.getProvider('openai-api-key');
          if (process.env.MOONBASE_TEST_TRANSCRIPT) {
            let stream;
            const message = text => fauxAssistantMessage([{type:'thinking',thinking:text.includes('second') ? 'Local thinking first and next' : 'Local thinking first'}, {type:'text',text}]);
            globalThis.transcriptTest = {
              first: () => stream.push({type:'text_delta',contentIndex:0,delta:'first',partial:message('## Held local response\\n\\nFirst local chunk 🌔')}),
              next: () => stream.push({type:'text_delta',contentIndex:0,delta:' second',partial:message('## Held local response\\n\\nFirst local chunk 🌔 and second chunk\\n\\n[Read](https://example.com/read)')}),
              finish: () => { const final=message('Local completed'); stream.push({type:'done',reason:'stop',message:final}); stream.end(final); },
            };
            models.setProvider({...original,streamSimple:(_model,_context,options)=>{
              stream=createAssistantMessageEventStream(); options?.signal?.addEventListener('abort',()=>stream.end(fauxAssistantMessage('Stopped',{stopReason:'aborted'})),{once:true}); return stream;
            }});
            return models;
          }

          if (process.env.MOONBASE_TEST_ACTIVITY) {
            const faux = fauxProvider({provider:'openai-api-key',tokensPerSecond:500});
            faux.setResponses([fauxAssistantMessage(fauxToolCall('controlled_activity',{}),{stopReason:'toolUse'}),fauxAssistantMessage('Local tool response finished')]);
            models.setProvider({...original,streamSimple:(model,context,options)=>faux.provider.streamSimple(model,context,options)});
            return models;
          }

          const faux = fauxProvider({provider:'openai-api-key',tokensPerSecond:500});
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall('write',{path:'local-result.txt',content:'first conversation'}),{stopReason:'toolUse'}),fauxAssistantMessage('First local response'),
            fauxAssistantMessage(fauxToolCall('write',{path:'local-result.txt',content:'second conversation'}),{stopReason:'toolUse'}),fauxAssistantMessage('Second local response'),
            fauxAssistantMessage('Active hidden local output '.repeat(1000)),
          ]);
          models.setProvider({...original,stream:faux.provider.stream,streamSimple:(model,context,options)=>{
            if(model.id !== 'gpt-6.1-sol' || options?.reasoning !== 'xhigh') throw Error('Expected the chosen Sol model and xhigh reasoning');
            return faux.provider.streamSimple(model,context,options);
          }});
          return models;
        `,
                ),
            };
          });
        },
      },
    ],
  });
});
test.afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test('native local setup, approved folders/models, streaming/tools, hidden work Quit choices and restart', async () => {
  test.setTimeout(60000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-ui-data-')));
  const first = join(directory, 'first'),
    second = join(directory, 'second');
  await mkdir(first);
  await mkdir(second);
  const launch = () =>
    electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: join(directory, 'data'),
        MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
      },
    });
  let app = await launch(),
    child = app.process(),
    page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const openChat = async () => {
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  };
  try {
    await openChat();
    await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const chrome = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        frame: window.getBounds(),
        content: window.getContentBounds(),
        background: window.getBackgroundColor(),
      };
    });
    expect(chrome.frame.height - chrome.content.height).toBeLessThanOrEqual(2);
    expect(chrome.content.y - chrome.frame.y).toBeLessThanOrEqual(2);
    expect(chrome.background.toLowerCase()).toBe('#14151b');
    await captureNative(app, page, resolve('../../test-results/redesign-review/native.png'));
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await expect(
      page.getByText('Set up a provider to send. Local tools are not sandboxed.', { exact: true }),
    ).toBeVisible();
    const context = await page.evaluate(() => window.moonbaseChat.context('local'));
    const unauthorized = await page.evaluate(
      async (context) =>
        window.moonbaseChat.call(
          'chat',
          'createChat',
          {
            session: context,
            requestId: 'forged',
            title: 'No approval',
            settings: {
              cwd: '/private/tmp',
              model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
            },
          },
          crypto.randomUUID(),
          'local',
        ),
      context,
    );
    expect(unauthorized).toMatchObject({ ok: false, error: { code: 'Unauthorized' } });
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Add key for OpenAI API key', exact: true }).click();
    await page
      .getByLabel('Enter OpenAI API key', { exact: true })
      .fill('sk-controlled-private-key');
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await closeSettings(page);
    await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
      'GPT-6.1 Sol',
    );
    await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
      'Medium',
    );
    // One chip holds the model and its effort; the effort is chosen in its popover.
    await page.getByRole('button', { name: 'Chat model', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Choose model', exact: true })
      .getByRole('radio', { name: 'Extra high', exact: true })
      .click();
    await page.keyboard.press('Escape');
    for (const [index, folder] of [first, second].entries()) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog;
      }, folder);
      await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Choose working folder', exact: true }),
      ).toHaveAttribute('title', folder);
      await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
        'GPT-6.1 Sol',
      );
      await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
        'Extra high',
      );
      await page.getByLabel('Message', { exact: true }).fill('Local conversation ' + index);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText(index ? 'Second local response' : 'First local response', { exact: true }),
      ).toBeVisible();
      expect(await readFile(join(folder, 'local-result.txt'), 'utf8')).toBe(
        index ? 'second conversation' : 'first conversation',
      );
      if (!index) await page.getByRole('button', { name: 'New chat', exact: true }).click();
    }
    await captureNative(app, page, test.info().outputPath('local-chat.png'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 600));
    await page.getByLabel('Message', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('Message', { exact: true })).toBeInViewport();
    await captureNative(app, page, test.info().outputPath('local-constrained.png'));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1280, 850);
      window.webContents.setZoomFactor(2);
    });
    await page.getByLabel('Message', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('Message', { exact: true })).toBeInViewport();
    await captureNative(app, page, test.info().outputPath('local-zoom-200.png'));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );

    await page.getByLabel('Message', { exact: true }).fill('Keep working');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: 'Agents', exact: true }).focus();
    await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await app.evaluate(({ dialog, app }) => {
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      app.quit();
    });
    await expect(page.getByRole('button', { name: 'Open Chat panel', exact: true })).toBeEnabled();
    expect(child.exitCode).toBeNull();
    await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await app.evaluate(({ dialog, app }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      app.quit();
    });
    await expect.poll(() => child.exitCode).toBe(0);
    app = await launch();
    child = app.process();
    page = await app.firstWindow();
    await openChat();
    // Both chats survive the restart; finished and seen, they may be Settled.
    await showChat(page, /Local conversation 0/);
    await showChat(page, /Local conversation 1/);
    const after = await page.evaluate(() => window.moonbaseChat.context('local'));
    expect(after).toEqual(context);
    const saved = await page.evaluate(() => localStorage.getItem('moonbase.chat.local.v1'));
    expect(saved).not.toContain('controlled-private-key');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
      'GPT-6.1 Sol',
    );
    await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
      'Extra high',
    );
    expect(errors).toEqual([]);
  } finally {
    if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('startup-failure Quit still confirms hidden local work before disposal', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-failed-startup-')));
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: directory,
      MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
      MOONBASE_TEST_STARTUP_FAILURE: 'editor',
      MOONBASE_TEST_LOCAL_ACTIVE: '1',
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  try {
    await expect(page.getByRole('alert', { name: 'Workbench startup failed' })).toBeVisible();
    const keep = join(directory, 'kept.json');
    await app.evaluate(({ app, dialog }, file) => {
      dialog.showMessageBox = (async (_window, options) => {
        process.getBuiltinModule('fs').writeFileSync(file, JSON.stringify(options));
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      app.quit();
    }, keep);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(keep, 'utf8')).buttons;
        } catch {
          return [];
        }
      })
      .toEqual(['Keep running', 'Quit']);
    expect(child.exitCode).toBeNull();
    await expect(page.getByRole('alert', { name: 'Workbench startup failed' })).toBeVisible();
    await app.evaluate(({ app, dialog }) => {
      dialog.showMessageBox = (async (_window, options) => ({
        response: options.buttons?.includes('Keep running') ? 1 : 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      app.quit();
    });
    await expect.poll(() => child.exitCode).toBe(1);
  } finally {
    if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('obsolete native confirmation cannot cancel the replacement document’s Quit or reopen its admissions', async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'moonbase-local-quit-replacement-')),
  );
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: directory,
      MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
      MOONBASE_TEST_STARTUP_FAILURE: 'editor',
      MOONBASE_TEST_LOCAL_ACTIVE: '1',
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  try {
    await expect(page.getByRole('alert', { name: 'Workbench startup failed' })).toBeVisible();
    await app.evaluate(({ app, dialog }) => {
      const state = globalThis as unknown as {
        localQuitDialogs: ((value: { response: number; checkboxChecked: boolean }) => void)[];
      };
      state.localQuitDialogs = [];
      dialog.showMessageBox = (async (_window, options) =>
        options.buttons?.includes('Keep running')
          ? new Promise((resolve) => state.localQuitDialogs.push(resolve))
          : { response: 0, checkboxChecked: false }) as typeof dialog.showMessageBox;
      app.quit();
    });
    const dialogs = () =>
      app.evaluate(
        () => (globalThis as unknown as { localQuitDialogs: unknown[] }).localQuitDialogs.length,
      );
    await expect.poll(dialogs).toBe(1);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await expect.poll(dialogs).toBe(2);
    await app.evaluate(() =>
      (
        globalThis as unknown as { localQuitDialogs: ((value: unknown) => void)[] }
      ).localQuitDialogs[0]({ response: 0, checkboxChecked: false }),
    );
    const denied = await page.evaluate(async (cwd) => {
      const session = await window.moonbaseChat.context('local');
      return window.moonbaseChat.call(
        'chat',
        'createChat',
        {
          session,
          requestId: 'fenced',
          title: 'Fenced',
          settings: { cwd, model: { provider: 'openai', modelId: 'gpt-6.1-sol' } },
        },
        crypto.randomUUID(),
        'local',
      );
    }, directory);
    expect(denied).toMatchObject({ ok: false, error: { code: 'Unavailable' } });
    await app.evaluate(() =>
      (
        globalThis as unknown as { localQuitDialogs: ((value: unknown) => void)[] }
      ).localQuitDialogs[1]({ response: 1, checkboxChecked: false }),
    );
    await expect.poll(() => child.exitCode).toBe(1);
  } finally {
    if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('a failed local activity scan during crash-Quit reports safely and recovers the renderer', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-crash-scan-')));
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: directory,
      MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
      MOONBASE_TEST_LOCAL_SCAN_ERROR: '1',
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  try {
    await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(async () => {
        try {
          return await app.evaluate(async ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
              'document.body.textContent',
            ),
          );
        } catch {
          return '';
        }
      })
      .toContain('Controlled activity scan failure');
    expect(child.exitCode).toBeNull();
    const editing = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        '[...document.querySelectorAll("button")].some(button => button.getAttribute("aria-label") === "Open checkout" && !button.disabled)',
      ),
    );
    expect(editing).toBe(true);
  } finally {
    if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('transcript local rendering precedes held completion; native Copy/link failures and actual 200% stay readable', async () => {
  test.setTimeout(60000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-transcript-native-')));
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: join(directory, 'data'),
      MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
      MOONBASE_TEST_TRANSCRIPT: '1',
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  type Control = {
    first(): void;
    next(): void;
    finish(): void;
    restore?(): Promise<void>;
    copied?: string[];
    links?: string[];
  };
  try {
    await openSettings(page, 'Providers');
    await page.getByRole('button', { name: 'Add key for OpenAI API key', exact: true }).click();
    await page
      .getByLabel('Enter OpenAI API key', { exact: true })
      .fill('sk-controlled-transcript-fixture');
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await closeSettings(page);
    await app.evaluate(({ dialog }, cwd) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [cwd],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Read the held local response');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await app.evaluate(() =>
      (globalThis as unknown as { transcriptTest: Control }).transcriptTest.first(),
    );
    const live = page.getByRole('article', { name: 'Live response' });
    await expect(live.getByRole('heading', { name: 'Held local response' })).toBeVisible();
    await expect(live.getByText('First local chunk 🌔', { exact: true })).toBeVisible();
    // Opening the Activity card shows its recorded parts, the running thought among them.
    const activity = live.getByRole('button', { name: /^Activity/ });
    await activity.click();
    const thought = live
      .locator('[data-transcript-part]')
      .filter({ hasText: /^Thinking/ })
      .locator('pre');
    await expect(thought).toHaveText('Local thinking first');
    await thought.focus();
    const reads = await app.evaluate(
      () => (globalThis as unknown as { activityReads: string[] }).activityReads.length,
    );
    await app.evaluate(() =>
      (globalThis as unknown as { transcriptTest: Control }).transcriptTest.next(),
    );
    await expect(
      live.getByText('First local chunk 🌔 and second chunk', { exact: true }),
    ).toBeVisible();
    await expect(live.getByText('Local thinking first and next', { exact: true })).toBeVisible();
    await expect(thought).toBeFocused();
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { activityReads: string[] }).activityReads.length,
      ),
    ).toBe(reads);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    expect(
      await app.evaluate(
        ({ clipboard }) =>
          clipboard.writeText ===
          (globalThis as unknown as { moonbaseTestClipboardWrite: unknown })
            .moonbaseTestClipboardWrite,
      ),
    ).toBe(true);
    await app.evaluate(({ clipboard, shell }) => {
      const original = clipboard.writeText.bind(clipboard);
      const control = (globalThis as unknown as { transcriptTest: Control }).transcriptTest;
      control.copied = [];
      clipboard.writeText = async (text) => {
        control.copied!.push(text);
      };
      control.restore = async () => {
        clipboard.writeText = original;
      };
      control.links = [];
      shell.openExternal = async (url) => {
        control.links!.push(url);
      };
    });
    await live.getByRole('button', { name: 'Copy message', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
    expect(
      await app.evaluate(() =>
        (globalThis as unknown as { transcriptTest: Control }).transcriptTest.copied!.at(-1),
      ),
    ).toBe(
      '## Held local response\n\nFirst local chunk 🌔 and second chunk\n\n[Read](https://example.com/read)',
    );
    await live.getByRole('link', { name: 'Read', exact: true }).click();
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { transcriptTest: Control }).transcriptTest.links,
      ),
    ).toEqual(['https://example.com/read']);
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = async () => {
        throw Error('Controlled OS clipboard failure');
      };
    });
    await live.getByRole('button', { name: 'Copy message', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    if ((await activity.getAttribute('aria-expanded')) === 'true') await activity.click();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1280, 850);
      window.webContents.setZoomFactor(2);
    });
    await expect(page.getByLabel('Message', { exact: true })).toBeInViewport();
    const layout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[aria-label="Agent workspace"]')!,
        grid = main.parentElement!;
      return {
        innerWidth,
        compact: matchMedia('(max-width: 640px)').matches,
        rootWidth: document.getElementById('root')!.getBoundingClientRect().width,
        mainWidth: main.getBoundingClientRect().width,
        railWidth: document.querySelector('[aria-label="Workbench views"]')!.getBoundingClientRect()
          .width,
        gridWidth: grid.getBoundingClientRect().width,
        columns: getComputedStyle(grid).gridTemplateColumns,
      };
    });
    await writeFile(
      resolve('../../test-results/transcript-111/native-zoom-layout.json'),
      JSON.stringify(layout, null, 2),
    );
    // Compact, the chat is one column filling the window beside the project rail.
    expect(layout.columns.split(' ')).toHaveLength(1);
    expect(layout.mainWidth).toBeGreaterThan(layout.innerWidth - layout.railWidth - 2);
    const reading = live.getByText('First local chunk 🌔 and second chunk', { exact: true });
    await reading.scrollIntoViewIfNeeded();
    // Away from the floating Jump to latest button, which covers the centre of a short list.
    await page
      .getByRole('region', { name: 'Chat transcript', exact: true })
      .hover({ position: { x: 24, y: 24 } });
    for (let attempt = 0; attempt < 8; attempt++) {
      const gap = await reading.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest('[aria-label="Chat transcript"]')!.getBoundingClientRect().top,
      );
      if (Math.abs(gap) < 0.25) break;
      await page.mouse.wheel(0, gap);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    }
    await page.screenshot({
      path: resolve('../../test-results/transcript-112/native-local-zoom.png'),
    });
    const geometry = await reading.evaluate((element) => ({
      reading: element.getBoundingClientRect().toJSON(),
      transcript: element
        .closest('[aria-label="Chat transcript"]')!
        .getBoundingClientRect()
        .toJSON(),
    }));
    await writeFile(
      resolve('../../test-results/transcript-112/native-local-zoom.json'),
      JSON.stringify(geometry, null, 2),
    );
    // Native scrolling at 200% rounds fractional CSS coordinates to device pixels.
    expect(geometry.reading.top).toBeGreaterThanOrEqual(geometry.transcript.top - 1);
    expect(geometry.reading.bottom).toBeLessThanOrEqual(geometry.transcript.bottom + 1);
    await captureNative(
      app,
      page,
      resolve('../../test-results/transcript-111/native-zoom-200.png'),
    );
    await page.getByLabel('Message', { exact: true }).focus();
    await app.evaluate(() =>
      (globalThis as unknown as { transcriptTest: Control }).transcriptTest.finish(),
    );
    await expect(page.getByText('Local completed', { exact: true })).toBeVisible();
  } finally {
    if (child.exitCode === null) {
      try {
        await app.evaluate(async () => {
          await (globalThis as unknown as { transcriptTest: Control }).transcriptTest.restore?.();
        });
      } finally {
        await app.evaluate(({ app }) => app.exit(0));
      }
    }
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

for (const mode of ['local', 'remote'] as const)
  test(`transcript ${mode} tool progress renders before held completion; Copy is injected and Stop stays independent`, async () => {
    test.setTimeout(60000);
    const host =
      mode === 'remote'
        ? await controlledHostFixture(
            new URL('../../../tests/chat/tool-host.mjs', import.meta.url),
            true,
          )
        : undefined;
    const directory =
      host?.directory ??
      (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-activity-native-'))));
    const app = await electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: join(directory, 'desktop'),
        MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
        ...(host
          ? {
              MOONBASE_CHAT_CONFIG: host.clientConfig,
              MOONBASE_CHAT_FORWARD_LOG: host.log,
              MOONBASE_TEST_ALLOW_LOOPBACK: '1',
            }
          : { MOONBASE_TEST_ACTIVITY: '1' }),
      },
    });
    const child = app.process(),
      page = await app.firstWindow();
    try {
      if (host) {
        await selectRemoteChat(page);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await createRemoteChat(page, 'Remote held activity');
      } else {
        await openSettings(page, 'Providers');
        await page.getByRole('button', { name: 'Add key for OpenAI API key', exact: true }).click();
        await page
          .getByLabel('Enter OpenAI API key', { exact: true })
          .fill('sk-controlled-activity-fixture');
        await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
        await closeSettings(page);
        await app.evaluate(({ dialog }, cwd) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [cwd],
          })) as typeof dialog.showOpenDialog;
        }, directory);
        await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
      }
      await page.getByLabel('Message', { exact: true }).fill('Observe held tool progress');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const live = page.getByRole('article', { name: 'Live response' });
      // Folded, the card shows the running call's state; opened, the output recorded so far.
      const part = live.locator('[data-transcript-part]').filter({ hasText: /· Output · running/ });
      await expect(part).toHaveCount(1);
      const group = live.getByRole('button', { name: /^Activity/ });
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await expect(live).toContainText('running');
      // A live row holding only the call's output has a visually hidden toggle; Enter opens it.
      await group.press('Enter');
      await expect(part.locator('pre')).toContainText(
        host ? 'Controlled remote tool activity' : 'First local tool chunk',
      );
      await part.locator('pre').focus();
      const before = host
        ? (await host.stats()).commands.filter((operation) => operation === 'getChat').length
        : await app.evaluate(
            () => (globalThis as unknown as { activityReads: string[] }).activityReads.length,
          );
      if (host) host.nextChunk();
      else
        await app.evaluate(() =>
          (globalThis as unknown as { localActivity: { next(): void } }).localActivity.next(),
        );
      const next = host
        ? 'Controlled remote tool activity\nFixed folder observed by the test tool.\n' +
          'preview '.repeat(800) +
          '\nControlled remote next tool chunk'
        : 'First local tool chunk and next update';
      await expect(part.locator('pre')).toHaveText(next);
      await expect(part.locator('pre')).toBeFocused();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
      const after = host
        ? (await host.stats()).commands.filter((operation) => operation === 'getChat').length
        : await app.evaluate(
            () => (globalThis as unknown as { activityReads: string[] }).activityReads.length,
          );
      expect(after).toBe(before);
      await part.getByRole('button', { name: 'Copy part', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
      expect(
        await app.evaluate(() =>
          (globalThis as unknown as { moonbaseTestClipboard: string[] }).moonbaseTestClipboard.at(
            -1,
          ),
        ),
      ).toBe(next);
      await mkdir(resolve('../../test-results/transcript-112'), { recursive: true });
      await page.screenshot({
        path: resolve(`../../test-results/transcript-112/native-${mode}-held-tool.png`),
      });
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      // One locator: Stop may leave the DOM between separate visibility and disabled checks.
      await expect(
        page.getByRole('button', { name: 'Stop', exact: true, disabled: false }),
      ).toHaveCount(0);
      await expect(page.getByRole('status', { name: 'Conversation status' })).toContainText(
        'Stopped',
      );
    } finally {
      host?.release();
      if (child.exitCode === null) {
        if (host) {
          // Still connected when the sidebar has no Connect line.
          if (!(await page.getByRole('button', { name: 'Connect', exact: true }).count()))
            await disconnectChat(page);
        }
        await app.evaluate(({ app }) => app.exit(0));
      }
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
      if (host) await host.close();
      else await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

test('transcript remote first/next chunks render through authenticated stream and Electron IPC before held completion', async () => {
  test.setTimeout(60000);
  const host = await controlledHostFixture(
    new URL('../../../tests/chat/stream-host.mjs', import.meta.url),
    true,
  );
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: join(host.directory, 'desktop'),
      MOONBASE_CHAT_CONFIG: host.clientConfig,
      MOONBASE_CHAT_FORWARD_LOG: host.log,
      MOONBASE_TEST_ALLOW_LOOPBACK: '1',
      MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  try {
    await selectRemoteChat(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await createRemoteChat(page, 'Remote held transcript');
    await page.getByLabel('Message', { exact: true }).fill('Observe actual remote chunks');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const live = page.getByRole('article', { name: 'Live response' });
    await expect(live.getByText('first remote text 0', { exact: true })).toBeVisible();
    await live.getByRole('button', { name: /^Activity/ }).click();
    const thought = live
      .locator('[data-transcript-part]')
      .filter({ hasText: /^Thinking/ })
      .locator('pre');
    await expect(thought).toHaveText('remote thinking 0');
    await thought.focus();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    const before = await host.stats();
    host.nextChunk();
    await expect(live.getByText('first remote text 4', { exact: true })).toBeVisible();
    await expect(live.getByText('remote thinking 4', { exact: true })).toBeVisible();
    await expect(thought).toBeFocused();
    const after = await host.stats();
    expect(after.reads!.scans).toBe(before.reads!.scans);
    expect(after.commands.filter((operation) => operation === 'getChat').length).toBe(
      before.commands.filter((operation) => operation === 'getChat').length,
    );
    await page.screenshot({
      path: resolve('../../test-results/transcript-111/native-remote-held.png'),
    });
    host.release();
    await page.getByLabel('Message', { exact: true }).focus();
    await expect(page.getByText('REMOTE COMPLETED', { exact: true })).toBeVisible();
  } finally {
    host.release();
    if (child.exitCode === null) {
      // Still connected when the sidebar has no Connect line.
      if (!(await page.getByRole('button', { name: 'Connect', exact: true }).count()))
        await disconnectChat(page);
      await app.evaluate(({ app }) => app.exit(0));
    }
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await host.close();
  }
});

for (const mode of ['local', 'remote'] as const)
  test(`stored image ${mode} record is served over moonbase:// under production CSP; viewer keyboard, close and actual zoom`, async () => {
    const host =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./stored-image-host.mjs', import.meta.url))
        : undefined;
    const directory =
      host?.directory ?? (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-image-native-'))));
    const app = await electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: join(directory, 'desktop'),
        MOONBASE_TEST_MAIN: pathToFileURL(join(fixtureDirectory, 'main.mjs')).href,
        ...(host
          ? {
              MOONBASE_CHAT_CONFIG: host.clientConfig,
              MOONBASE_CHAT_FORWARD_LOG: host.log,
              MOONBASE_TEST_ALLOW_LOOPBACK: '1',
            }
          : {
              MOONBASE_TEST_ACTIVITY: '1',
              MOONBASE_TEST_IMAGES: retainedImage.toString('base64'),
            }),
      },
    });
    const child = app.process(),
      page = await app.firstWindow();
    try {
      expect(page.url()).toBe('moonbase://editor/index.html');
      await page.evaluate(() => {
        const control = { violations: [] as string[] };
        (window as unknown as { nativeImages: typeof control }).nativeImages = control;
        window.addEventListener('securitypolicyviolation', (event) =>
          control.violations.push(event.violatedDirective),
        );
      });
      if (host) {
        await selectRemoteChat(page);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await createRemoteChat(page, 'Retained remote images');
      } else {
        await openSettings(page, 'Providers');
        await page.getByRole('button', { name: 'Add key for OpenAI API key', exact: true }).click();
        await page
          .getByLabel('Enter OpenAI API key', { exact: true })
          .fill('sk-controlled-image-fixture');
        await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
        await closeSettings(page);
        await app.evaluate(({ dialog }, cwd) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [cwd],
          })) as typeof dialog.showOpenDialog;
        }, directory);
        await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
      }
      await page.getByLabel('Message', { exact: true }).fill('Inspect retained images');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      if (!host) {
        // The tool is running once its output part is recorded; the output itself stays folded.
        await expect(
          page
            .getByRole('article', { name: 'Live response' })
            .locator('[data-transcript-part]')
            .filter({ hasText: /· Output · running/ }),
        ).toHaveCount(1);
        await app.evaluate(() =>
          (globalThis as unknown as { localActivity: { release(): void } }).localActivity.release(),
        );
      }
      const group = page
        .locator('[data-transcript-activity]')
        .filter({ has: page.locator('[data-transcript-part]').filter({ hasText: 'Stored image' }) })
        .first();
      await expect(group).toBeAttached();
      // An output row's toggle is visually hidden; it still opens from the keyboard.
      const activity = group.getByRole('button', { name: /^Activity/ });
      if ((await activity.getAttribute('aria-expanded')) !== 'true') await activity.press('Enter');
      const trigger = group.getByRole('button', { name: 'View stored image', exact: true }).first();
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toBeEnabled();
      const thumbnail = trigger.getByRole('img', { name: 'Stored image thumbnail' });
      const src = (await thumbnail.getAttribute('src'))!;
      expect(src).toMatch(/^moonbase:\/\/editor\/transcript-image\/[A-Za-z0-9_-]{43}$/);
      expect(await thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(192);
      // The URL is only an opaque token; a guessed token and a non-image path grant nothing.
      expect(
        await page.evaluate(async (src) => {
          const statuses = [];
          for (const url of [src.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), src])
            statuses.push((await fetch(url, { cache: 'no-store' })).status);
          const response = await fetch(src);
          return [
            ...statuses,
            response.headers.get('Content-Type'),
            response.headers.get('X-Content-Type-Options'),
            response.headers.get('Cache-Control'),
          ];
        }, src),
      ).toEqual([404, 200, 'image/png', 'nosniff', 'no-store']);
      for (let iteration = 0; iteration < 3; iteration++) {
        await trigger.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
        await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect
          .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
          .toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(1280, 850);
        window.webContents.setZoomFactor(2);
      });
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toBeEnabled();
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
      await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
      await mkdir(resolve('../../test-results/transcript-images'), { recursive: true });
      await captureNative(
        app,
        page,
        resolve(`../../test-results/transcript-images/native-${mode}-zoom.png`),
      );
      const rect = await dialog.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: innerWidth,
          height: innerHeight,
        };
      });
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(rect.width);
      expect(rect.bottom).toBeLessThanOrEqual(rect.height);
      await page.keyboard.press('Escape');
      const stats = await page.evaluate(
        () => (window as unknown as { nativeImages: { violations: string[] } }).nativeImages,
      );
      expect(stats.violations).toEqual([]);
      expect(
        await app.evaluate(
          () =>
            (globalThis as unknown as { moonbaseTestClipboard: string[] }).moonbaseTestClipboard,
        ),
      ).toEqual([]);
    } finally {
      try {
        if (child.exitCode === null && host) {
          await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            window.setSize(1280, 850);
            window.webContents.setZoomFactor(1);
          });
          await disconnectChat(page);
        }
      } finally {
        try {
          if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
          await expect
            .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
            .toBe(true);
        } finally {
          if (host) console.info('Image native remote cleanup', await host.close());
          else await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        }
      }
    }
  });
