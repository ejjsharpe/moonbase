import { findTestBun, prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import { prepareCrashRecovery } from '../fixtures/editor-regressions.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

declare global {
  var recoveryChoice: ((value: { response: number; checkboxChecked: boolean }) => void) | undefined;
  var recoveryButtons: string[];
}
for (const action of ['Recover workbench', 'Quit Moonbase', 'cleanup failure'])
  test(`native recovery action: ${action}`, async () => {
    const data = mkdtempSync(join(tmpdir(), 'moonbase-recovery-'));
    await prepareDaemonData(data);
    const app = await electron.launch({
      args: ['-r', resolve('test/fixtures/faux-daemon-preload.cjs'), resolve('dist/main.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: data,
        MOONBASE_TEST_BUN: findTestBun(),
      },
    });
    const child = app.process();
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
      await prepareCrashRecovery(app);
      if (action === 'cleanup failure') {
        // A real scoped finalizer fails after the renderer has acknowledged disposal.
        await app.evaluate(async () => {
          const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
          const close = DatabaseSync.prototype.close;
          DatabaseSync.prototype.close = function () {
            close.call(this);
            throw Error('Controlled finalizer failure');
          };
        });
      } else {
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
        );
        await expect
          .poll(() => app.evaluate(() => globalThis.recoveryButtons))
          .toEqual(['Recover workbench', 'Quit Moonbase']);
        await app.evaluate(
          (_, response) => globalThis.recoveryChoice!({ response, checkboxChecked: false }),
          action === 'Recover workbench' ? 0 : 1,
        );
      }
      if (action === 'Recover workbench') {
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `!!document.querySelector('button')`,
              ),
            ),
          )
          .toBe(true);
      }
      if (action !== 'Quit Moonbase') {
        const accelerator = await app.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find(
            (item) => item.label === 'Quit Moonbase',
          )!;
          item.click();
          return item.accelerator;
        });
        expect(accelerator).toBe('CmdOrCtrl+Q');
      }
      if (action === 'cleanup failure') {
        await expect
          .poll(() => app.evaluate(() => globalThis.recoveryButtons))
          .toEqual(['Quit Moonbase']);
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
              "document.getElementById('root').childElementCount",
            ),
          ),
        ).toBe(0);
        await app.evaluate(() =>
          globalThis.recoveryChoice!({ response: 0, checkboxChecked: false }),
        );
      }
      await expect.poll(() => child.exitCode).toBe(action === 'cleanup failure' ? 1 : 0);
    } finally {
      try {
        if (child.exitCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve));
          await app.evaluate(({ app }) => app.exit(0));
          await exited;
        }
      } finally {
        // A daemon outlives its app: stop it even when the steps before fail.
        await stopDaemon(join(data, 'daemon-v1'));
      }
      rmSync(data, { recursive: true, force: true, maxRetries: 5 });
    }
  });
