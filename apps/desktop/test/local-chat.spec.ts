import assert from 'node:assert/strict';
import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { controlledHostFixture } from '../../../tests/chat/fixture.ts';
import { selectRemoteChat, createRemoteChat } from './chat-target.ts';
import { captureNative } from './editor-regressions.ts';

let fixtureDirectory: string;
test.beforeAll(async () => {
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
            const message = text => fauxAssistantMessage(text);
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
    expect(chrome.background).toBe('#141415');
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
    await page.getByRole('combobox', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name: 'OpenAI API key', exact: true }).click();
    await page.getByRole('button', { name: 'Set API key', exact: true }).click();
    await page
      .getByLabel('Enter OpenAI API key', { exact: true })
      .fill('sk-controlled-private-key');
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: 'Conversation model', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('combobox', { name: 'Conversation model', exact: true }),
    ).toContainText('GPT-6.1 Sol');
    await expect(
      page.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
    ).toContainText('Medium');
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).click();
    await page.getByRole('option', { name: 'Extra high', exact: true }).click();
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
      await expect(
        page.getByRole('combobox', { name: 'Conversation model', exact: true }),
      ).toContainText('GPT-6.1 Sol');
      await expect(
        page.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
      ).toContainText('Extra high');
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
    await expect(page.getByRole('button', { name: /Local conversation 0/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Local conversation 1/ })).toBeVisible();
    const after = await page.evaluate(() => window.moonbaseChat.context('local'));
    expect(after).toEqual(context);
    const saved = await page.evaluate(() => localStorage.getItem('moonbase.chat.local.v1'));
    expect(saved).not.toContain('controlled-private-key');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: 'Conversation model', exact: true }),
    ).toContainText('GPT-6.1 Sol');
    await expect(
      page.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
    ).toContainText('Extra high');
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
    await page.getByRole('combobox', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name: 'OpenAI API key', exact: true }).click();
    await page.getByRole('button', { name: 'Set API key', exact: true }).click();
    await page
      .getByLabel('Enter OpenAI API key', { exact: true })
      .fill('sk-controlled-transcript-fixture');
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
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
    await app.evaluate(() =>
      (globalThis as unknown as { transcriptTest: Control }).transcriptTest.next(),
    );
    await expect(
      live.getByText('First local chunk 🌔 and second chunk', { exact: true }),
    ).toBeVisible();
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
        gridWidth: grid.getBoundingClientRect().width,
        columns: getComputedStyle(grid).gridTemplateColumns,
      };
    });
    await writeFile(
      resolve('../../test-results/transcript-111/native-zoom-layout.json'),
      JSON.stringify(layout, null, 2),
    );
    expect(layout.mainWidth).toBeGreaterThan(layout.innerWidth - 2);
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
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    const before = await host.stats();
    host.nextChunk();
    await expect(live.getByText('first remote text 4', { exact: true })).toBeVisible();
    const after = await host.stats();
    expect(after.reads!.scans).toBe(before.reads!.scans);
    await page.screenshot({
      path: resolve('../../test-results/transcript-111/native-remote-held.png'),
    });
    host.release();
    await expect(page.getByText('REMOTE COMPLETED', { exact: true })).toBeVisible();
  } finally {
    host.release();
    if (child.exitCode === null) {
      const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
      if (await disconnect.isVisible()) {
        await disconnect.click();
        await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
      }
      await app.evaluate(({ app }) => app.exit(0));
    }
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await host.close();
  }
});
