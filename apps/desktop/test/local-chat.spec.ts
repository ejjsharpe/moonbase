import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
          builder.onLoad({ filter: /desktop\/src\/main\.ts$/ }, async ({ path }) => ({
            loader: 'ts',
            contents: (await readFile(path, 'utf8')).replace(
              '  let local = localResult.backend;',
              "  let local = localResult.backend; if (local && process.env.MOONBASE_TEST_LOCAL_ACTIVE) local.control.hasActiveWork = () => Effect.succeed(true); if (local && process.env.MOONBASE_TEST_LOCAL_SCAN_ERROR) local.control.hasActiveWork = () => Effect.fail(new ApplicationError({ code: 'Persistence', message: 'Controlled activity scan failure' }));",
            ),
          }));
          builder.onLoad({ filter: /pi-runtime\/src\/local-models\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            return {
              loader: 'ts',
              contents:
                `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';\n` +
                source.replace(
                  '  return models;',
                  `
          const original = models.getProvider('openai-api-key');
          const faux = fauxProvider({provider:'openai-api-key',tokensPerSecond:500});
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall('write',{path:'local-result.txt',content:'first conversation'}),{stopReason:'toolUse'}),fauxAssistantMessage('First local response'),
            fauxAssistantMessage(fauxToolCall('write',{path:'local-result.txt',content:'second conversation'}),{stopReason:'toolUse'}),fauxAssistantMessage('Second local response'),
            fauxAssistantMessage('Active hidden local output '.repeat(1000)),
          ]);
          models.setProvider({...original,stream:faux.provider.stream,streamSimple:faux.provider.streamSimple});
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
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  };
  try {
    await openChat();
    await expect(page.getByText('On this computer', { exact: true })).toBeVisible();
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
    for (const [index, folder] of [first, second].entries()) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog;
      }, folder);
      await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
      await expect(page.getByText(folder, { exact: true })).toBeVisible();
      await page.getByRole('combobox', { name: 'Conversation model', exact: true }).click();
      await page.getByRole('option').nth(index).click();
      await page.getByLabel('New saved chat').fill('Local conversation ' + index);
      await page.getByRole('button', { name: 'Create chat', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Local conversation ' + index, exact: true }),
      ).toBeVisible();
      await page.getByLabel('Message', { exact: true }).fill('Write in this local working folder');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText(index ? 'Second local response' : 'First local response', { exact: true }),
      ).toBeVisible();
      expect(await readFile(join(folder, 'local-result.txt'), 'utf8')).toBe(
        index ? 'second conversation' : 'first conversation',
      );
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
    await page.getByRole('tab', { name: 'Chat', exact: true }).focus();
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
        '[...document.querySelectorAll("button")].some(button => button.textContent === "Open checkout" && !button.disabled)',
      ),
    );
    expect(editing).toBe(true);
  } finally {
    if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
