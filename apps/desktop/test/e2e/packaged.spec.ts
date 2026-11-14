import { prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import { closeSettings, openSettings } from '../fixtures/chat-fixture.ts';
import {
  saveFile,
  selectFileView,
  captureNative,
  pasteNativeFile,
  explorerAction,
} from '../fixtures/editor-fixture.ts';
import {
  filenameCases,
  checkFilenameMaps,
  checkTabMenu,
  recoveryState,
} from '../fixtures/editor-fixture.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('unsigned macOS package runs with only system PATH, SQLite, native/rg resources and CSP workers', async () => {
  test.setTimeout(45000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-package-'))),
    checkout = join(base, 'checkout');
  mkdirSync(checkout);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      checkout,
      '-c',
      'user.name=Package Test',
      '-c',
      'user.email=package@example.invalid',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'package.ts'), "export const packaged = 'original';\n");
  writeFileSync(join(checkout, 'lookup-native-resource.txt'), 'qualified rg fixture');
  for (const path of filenameCases) writeFileSync(join(checkout, path), 'baseline ' + path);
  git('add', '.');
  git('commit', '-qm', 'Package fixture');
  const executablePath = resolve(
    `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/MacOS/Moonbase`,
  );
  await prepareDaemonData(join(base, 'fresh-user-data'));
  const launch = () =>
    electron.launch({
      executablePath,
      args: [],
      env: {
        PATH: '/usr/bin:/bin',
        PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        MOONBASE_USER_DATA: join(base, 'fresh-user-data'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      timeout: 20000,
    });
  let app = await launch(),
    child = app.process(),
    page = await app.firstWindow();
  const errors: string[] = [];
  const observe = () => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  };
  observe();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  };
  const screen = async (name: string) => {
    await captureNative(app, page, test.info().outputPath(`packaged-${name}.png`));
  };
  try {
    const resource = await app.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule('fs'),
        path = process.getBuiltinModule('path'),
        crypto = process.getBuiltinModule('crypto');
      const resources = process.resourcesPath,
        assets = path.join(resources, 'app.asar/renderer/assets');
      const files = [
        'workspace/filesystem',
        'workspace/ripgrep/rg',
        'workspace/ripgrep/COPYING',
        'workspace/ripgrep/LICENSE-MIT',
        'workspace/ripgrep/UNLICENSE',
        'app.asar/dependency-notices.txt',
        'LICENSE.electron.txt',
        'LICENSES.chromium.html',
      ];
      return {
        packaged: app.isPackaged,
        electron: process.versions.electron,
        node: process.versions.node,
        path: process.env.PATH,
        assets: fs.readdirSync(assets),
        files: files.map((name) => ({
          name,
          bytes: fs.statSync(path.join(resources, name)).size,
          mode: fs.statSync(path.join(resources, name)).mode & 0o777,
          sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(resources, name)))
            .digest('hex'),
        })),
        notices: fs.readFileSync(path.join(resources, 'app.asar/dependency-notices.txt'), 'utf8'),
      };
    });
    expect(resource.packaged).toBe(true);
    expect(resource.path).toBe('/usr/bin:/bin');
    expect(resource.node).toBe('24.22.1');
    expect(
      resource.files
        .filter((file) => ['workspace/filesystem', 'workspace/ripgrep/rg'].includes(file.name))
        .every((file) => file.mode & 0o111),
    ).toBe(true);
    const workers = resource.assets.filter((name) =>
      /^(editor|json|css|html|ts)\.worker.*\.js$/.test(name),
    );
    expect(workers).toHaveLength(5);
    expect(resource.assets.some((name) => name.endsWith('.ttf'))).toBe(true);
    expect(resource.notices).toContain('@stylexjs/stylex@0.19.1');
    expect(resource.notices).toContain('monaco-editor@0.57.0');
    expect(resource.notices).toContain('MIT License');
    await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(
      (await openSettings(page)).getByText('Local ready', { exact: true }),
    ).toBeVisible();
    await (
      await openSettings(page, 'Providers')
    )
      .getByRole('button', { name: 'Sign in to ChatGPT subscription', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Open sign-in page', exact: true }),
    ).toBeVisible();
    await expect(
      // The sign-in runs in the packaged daemon on this Mac, whose callback finishes it.
      page.getByLabel(
        'Finish signing in in your browser; Moonbase completes it by itself. If it does not, paste the final redirect URL here.',
        { exact: true },
      ),
    ).toBeVisible();
    await screen('local-oauth-loaded');
    await page.getByRole('button', { name: 'Cancel setup', exact: true }).click();
    await expect(page.getByText('Setup cancelled.', { exact: true })).toBeVisible();
    await closeSettings(page);
    expect(resource.notices).toContain('@earendil-works/pi-durable@1.4.0');
    expect(resource.notices).toContain('@earendil-works/pi-ai@1.4.0');

    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [root],
      })) as typeof dialog.showOpenDialog;
    }, checkout);
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    await explorerAction(page, 'Go to File…');
    await page.getByRole('combobox').fill('lookup-native');
    await expect(page.getByRole('option').first()).toHaveAccessibleName(
      'lookup-native-resource.txt',
    );
    await page.keyboard.press('Escape');
    await page.getByRole('treeitem', { name: 'package.ts', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: 'package.ts editor', exact: true });
    await input.focus();
    await input.press('Meta+a');
    await input.pressSequentially('export const packaged = 42;');
    await saveFile(page);
    await expect
      .poll(() => readFileSync(join(checkout, 'package.ts'), 'utf8'))
      .toBe('export const packaged = 42;');
    await selectFileView(page, 'staged');
    await expect(page.getByRole('textbox', { name: / original$/ })).toHaveCount(1);
    await explorerAction(page, 'New File…');
    const created = page.getByRole('textbox', { name: 'New file name', exact: true });
    await created.fill('packaged-created.txt');
    await created.press('Enter');
    await expect(
      page.getByRole('tab', { name: 'packaged-created.txt', exact: true }),
    ).toBeVisible();
    const native = join(base, 'package-native.txt');
    writeFileSync(native, 'PACKAGED NATIVE IMPORT');
    await pasteNativeFile(app, page, native);
    await page.getByLabel('Destination relative path').fill('packaged-import.txt');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Import files', exact: true })
      .click();
    await expect
      .poll(() => {
        try {
          return readFileSync(join(checkout, 'packaged-import.txt'), 'utf8');
        } catch {
          return '';
        }
      })
      .toBe('PACKAGED NATIVE IMPORT');
    await page.getByRole('tab', { name: 'package.ts', exact: true }).click();
    const workerErrors = await page.evaluate(async (workers) => {
      const failures: string[] = [];
      await Promise.all(
        workers.map(
          (name) =>
            new Promise<void>((resolve) => {
              const worker = new Worker(new URL('./assets/' + name, location.href));
              worker.onerror = (event) => failures.push(event.message);
              setTimeout(() => {
                worker.terminate();
                resolve();
              }, 300);
            }),
        ),
      );
      return failures;
    }, workers);
    expect(workerErrors).toEqual([]);
    expect(errors).toEqual([]);
    mkdirSync('test-results', { recursive: true });
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
    );
    writeFileSync('test-results/packaged-editor.png', Buffer.from(capture, 'base64'));
    writeFileSync(
      'test-results/packaged-resources.json',
      JSON.stringify(
        {
          ...resource,
          notices: undefined,
          workerErrors,
          asarSha256: createHash('sha256')
            .update(
              readFileSync(
                resolve(
                  `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/Resources/app.asar`,
                ),
              ),
            )
            .digest('hex'),
          fixture:
            'fresh temporary Git repository with package.ts and lookup-native-resource.txt, UI-created packaged-created.txt and token-imported packaged-import.txt; no provider environment',
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            devicePixelRatio,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    const filenameEvidence = await checkFilenameMaps(page, checkout, 'package.ts', async () => {
      await stop();
      app = await launch();
      child = app.process();
      page = await app.firstWindow();
      observe();
      await page.getByRole('tab', { name: 'checkout · main', exact: true }).click();
      return page;
    });
    await screen('filename-maps');
    await page.getByRole('tab', { name: 'packaged-created.txt', exact: true }).hover();
    const closeCreated = page.getByRole('button', {
      name: 'Close packaged-created.txt',
      exact: true,
    });
    await expect(closeCreated).toHaveCSS('pointer-events', 'auto');
    await closeCreated.click();
    await expect(page.getByRole('tab', { name: 'packaged-created.txt', exact: true })).toHaveCount(
      0,
    );
    // At the small zoomed size the project chats dock would leave the editor no width for its tabs.
    await page.getByRole('button', { name: 'Hide project chats', exact: true }).click();
    await checkTabMenu(app, page, screen, 'packaged-created.txt');
    writeFileSync(
      'test-results/packaged-filename-maps.json',
      JSON.stringify(filenameEvidence, null, 2) + '\n',
    );
    expect(errors).toEqual([]);
    const dirty = (await recoveryState(page)).state.drafts.length;
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.quit());
    for (let index = 0; index < dirty; index++)
      await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await closed;
  } finally {
    try {
      await stop();
    } finally {
      // A daemon outlives its app: stop it even when the steps before fail.
      await stopDaemon(join(base, 'fresh-user-data', 'daemon-v1'));
    }
    rmSync(base, { recursive: true, force: true });
  }
});
