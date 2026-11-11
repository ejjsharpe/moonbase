import { findTestBun, prepareDaemonData, stopDaemon } from './faux-daemon.mjs';
import { saveFile, captureNative } from './editor-regressions.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native Reload retains text painted before ordinary recovery debounce', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-reload-'))),
    checkout = join(base, 'checkout');
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'a.ts'), 'const original = 1;\n');
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        checkout,
        '-c',
        'user.name=Reload Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
    );
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'Controlled reload fixture');
  const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
  await prepareDaemonData(join(base, 'user-data'));
  const app = await electron.launch({
    ...(packaged
      ? {
          executablePath:
            process.env.MOONBASE_RELOAD_EXECUTABLE ??
            resolve('release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase'),
        }
      : {}),
    args: packaged
      ? []
      : [
          '-r',
          resolve('test/faux-daemon-preload.cjs'),
          process.env.MOONBASE_RELOAD_MAIN ?? resolve('dist/main.mjs'),
        ],
    env: {
      PATH: '/usr/bin:/bin',
      PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: join(base, 'user-data'),
      MOONBASE_TEST_BUN: findTestBun(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  const child = app.process(),
    pids = new Set<number>([child.pid!]),
    errors: string[] = [];
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  const recovery = () =>
    page.evaluate(async () => {
      const reply = await window.moonbase.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
        crypto.randomUUID(),
      );
      if (!reply.ok) throw Error(reply.error.message);
      return reply.value as RecoveryLoad;
    });
  const reload = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<string>((resolve) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const finish = (value: string) => {
            contents.removeListener('will-prevent-unload', veto);
            contents.removeListener('did-finish-load', loaded);
            resolve(value);
          };
          const veto = () => finish('veto'),
            loaded = () => finish('reload');
          contents.once('will-prevent-unload', veto);
          contents.once('did-finish-load', loaded);
          contents.reload();
        }),
    );
  try {
    await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [root],
      })) as typeof dialog.showOpenDialog;
    }, checkout);
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    await page.getByRole('treeitem', { name: 'a.ts', exact: true }).dblclick();
    const editor = () => page.getByRole('textbox', { name: 'a.ts editor', exact: true });
    await editor().focus();
    await editor().press('Meta+a');
    await editor().pressSequentially('local dirty draft');
    await expect
      .poll(async () => (await recovery()).state.drafts[0]?.text)
      .toBe('local dirty draft');
    await editor().focus();
    await editor().press('End');
    await page.evaluate(() =>
      document.addEventListener(
        'input',
        () => Object.assign(window, { reloadInputAt: performance.now() }),
        { capture: true },
      ),
    );
    await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      await contents.insertText(' fresh visible tail');
      await contents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      );
    });
    const before = await page.evaluate(async () => {
      const persisted = await window.moonbase.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
        crypto.randomUUID(),
      );
      return {
        text: document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '),
        elapsed: performance.now() - (window as unknown as { reloadInputAt: number }).reloadInputAt,
        persisted,
      };
    });
    expect(before.text).toContain('fresh visible tail');
    expect(before.elapsed).toBeLessThan(150);
    const outcome = await reload();
    const project = page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .getByRole('tab', { name: 'checkout · main', exact: true });
    if (outcome === 'reload') await project.click();
    await expect(editor()).toBeVisible();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const after = await page.evaluate(() =>
      document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '),
    );
    await captureNative(app, page, test.info().outputPath('fresh-reload.png'));
    writeFileSync(
      test.info().outputPath('fresh-reload.json'),
      JSON.stringify({ before, outcome, after, recovery: await recovery() }, null, 2),
    );
    expect(after).toContain('fresh visible tail');
    // A durable dirty draft must eventually permit an actual reload, without Save or Discard.
    await expect
      .poll(async () => (await recovery()).state.drafts[0]?.text)
      .toContain('fresh visible tail');
    await expect.poll(reload).toBe('reload');
    await project.click();
    await expect(editor()).toBeVisible();
    await expect.poll(async () => await editor().inputValue()).toBeDefined();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '),
        ),
      )
      .toContain('fresh visible tail');
    await saveFile(page);
    await expect
      .poll(() => readFileSync(join(checkout, 'a.ts'), 'utf8'))
      .toContain('fresh visible tail');
    expect(errors).toEqual([]);
  } finally {
    try {
      for (const pid of await app.evaluate(({ app }) =>
        app.getAppMetrics().map((value) => value.pid),
      ))
        pids.add(pid);
      await app.context().tracing.stop({ path: test.info().outputPath('trace.zip') });
      // Fault teardown releases the optional public connection before intentional exit.
      await page
        .evaluate(async () => {
          const bridge = (
            window as unknown as {
              moonbaseChat?: {
                call(
                  ...args: unknown[]
                ): Promise<{ ok: boolean; value?: { connectionId?: string } }>;
              };
            }
          ).moonbaseChat;
          if (!bridge) return;
          const state = await bridge.call('connection', 'getConnection', {}, crypto.randomUUID());
          if (state.ok && state.value?.connectionId)
            await bridge.call(
              'connection',
              'disconnect',
              { connectionId: state.value.connectionId },
              crypto.randomUUID(),
            );
        })
        .catch(() => {});
      await app.evaluate(({ app }) => app.exit(0));
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
      for (const pid of pids)
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          })
          .toBe(true);
    } finally {
      // A daemon outlives its app: stop it even when the steps before fail.
      await stopDaemon(join(base, 'user-data', 'daemon-v1'));
    }
    rmSync(base, { recursive: true });
    writeFileSync(
      test.info().outputPath('cleanup.json'),
      JSON.stringify(
        { pids: [...pids], absent: true, directory: base, removed: true, configured: false },
        null,
        2,
      ),
    );
  }
});
