import { waitForExit } from '../fixtures/app-fixture.ts';
import { callMain, disconnectHost, editorClientId } from '../fixtures/window-ipc-fixture.ts';
import { findTestBun, prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import { saveFile, draftsOf } from '../fixtures/editor-fixture.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native Reload retains text painted before ordinary recovery debounce @packaged', async () => {
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
          resolve('test/fixtures/faux-daemon-preload.cjs'),
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
  page.on('pageerror', (error) => {
    // Monaco 0.57's suggest model can read its completion model after a retrigger cleared it
    // while typing starts a new word; that upstream race is not what this test checks.
    if (!error.message.includes("reading 'getItemsByProvider'")) errors.push(error.message);
  });
  const recovery = async () => {
    const reply = await callMain(page, 'loadRecovery', { clientId: editorClientId });
    if (!reply.ok) throw Error(JSON.stringify(reply.error));
    return reply.value as RecoveryLoad;
  };
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
    await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible({
      timeout: 30_000,
    });
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
      .poll(async () => draftsOf((await recovery()).state)[0]?.text)
      .toBe('local dirty draft');
    await editor().focus();
    await editor().press('End');
    // The page's delayed timers wait until Reload, so the recovery debounce can't send the tail
    // before then however slowly the page paints. Zero-delay timers, the runtime's own yields,
    // still run.
    await page.evaluate(() => {
      const setTimer = window.setTimeout,
        clearTimer = window.clearTimeout,
        held = new Map<number, () => number>(),
        started = new Map<number, number>();
      let next = -1;
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (!delay || delay <= 0) return setTimer(handler, delay, ...args);
        const id = next--;
        held.set(id, () => setTimer(handler, delay, ...args));
        return id;
      }) as typeof window.setTimeout;
      // A held timer cleared after it started clears the timer it became.
      window.clearTimeout = ((id?: number) => {
        if (id !== undefined && held.delete(id)) return;
        clearTimer(started.get(id!) ?? id);
      }) as typeof window.clearTimeout;
      Object.assign(window, {
        releaseTimers: () => {
          window.setTimeout = setTimer;
          for (const [id, start] of held) started.set(id, start());
          held.clear();
        },
      });
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.insertText(' fresh visible tail'),
    );
    await expect(page.locator('.view-lines')).toContainText('fresh visible tail');
    // Painted, and not yet in the recovery store: Reload alone has to keep it.
    expect(draftsOf((await recovery()).state)[0]?.text).toBe('local dirty draft');
    await page.evaluate(() => (window as unknown as { releaseTimers(): void }).releaseTimers());
    const outcome = await reload();
    const project = page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .getByRole('tab', { name: 'checkout · main', exact: true });
    if (outcome === 'reload') await project.click();
    await expect(editor()).toBeVisible();
    await expect(page.locator('.view-lines')).toContainText('fresh visible tail');
    // A durable dirty draft must eventually permit an actual reload, without Save or Discard.
    await expect
      .poll(async () => draftsOf((await recovery()).state)[0]?.text)
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
      // Fault teardown releases the optional public connection before intentional exit.
      await disconnectHost(page).catch(() => {});
      await app.evaluate(({ app }) => app.exit(0));
      await waitForExit(child);
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
  }
});
