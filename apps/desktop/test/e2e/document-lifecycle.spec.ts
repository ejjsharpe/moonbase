import { findTestBun, prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import { prepareCrashRecovery, recoverCrashedWorkbench } from '../fixtures/editor-fixture.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

declare global {
  var reloadProbe: { cancels: string[]; held: number | null; stopped: boolean };
}
for (const mode of ['reload', 'veto', 'crash'])
  test(`standalone document ${mode} owns exact observers and read-only waits`, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-document-'))),
      checkout = join(base, 'checkout');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'a.ts'), 'original');
    execFileSync('/usr/bin/git', ['-C', checkout, 'init', '-q', '-b', 'main']);
    const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
    await prepareDaemonData(join(base, 'data'));
    // The read helper runs in the daemon: this folder lets the test stop one read in flight there.
    const hold = join(base, 'hold');
    mkdirSync(hold);
    const app = await electron.launch({
      ...(packaged
        ? {
            executablePath:
              process.env.MOONBASE_RELOAD_EXECUTABLE ??
              resolve('release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase'),
          }
        : {}),
      args: packaged ? [] : [resolve('test/fixtures/editor-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: join(base, 'data'),
        MOONBASE_TEST_BUN: findTestBun(),
        ...(packaged ? {} : { MOONBASE_TEST_HOLD_READ: hold }),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    const child = app.process(),
      pids = new Set<number>([child.pid!]),
      page = await app.firstWindow();
    try {
      await app.evaluate(() => {
        globalThis.reloadProbe = { cancels: [], held: null, stopped: false };
        if (globalThis.desktopTest)
          Object.defineProperty(globalThis.reloadProbe, 'cancels', {
            get: () => globalThis.desktopTest.cancelIds,
          });
      });
      await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
      await page.evaluate(() => {
        Object.assign(window, {
          oldEditorObservers: [] as string[],
          documentIdentity: crypto.randomUUID(),
        });
        window.moonbase.events((id) => {
          const ids = (window as unknown as { oldEditorObservers: string[] }).oldEditorObservers;
          if (!ids.includes(id)) ids.push(id);
        });
      });
      const identity = await page.evaluate(
        () => (window as unknown as { documentIdentity: string }).documentIdentity,
      );
      await app.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [root],
        })) as typeof dialog.showOpenDialog;
      }, checkout);
      await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
      await page.getByRole('treeitem', { name: 'a.ts, untracked', exact: true }).dblclick();
      const editor = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
      await editor.focus();
      await editor.press('Meta+a');
      await editor.pressSequentially('durable dirty text');
      const recovery = () =>
        page.evaluate(async () => {
          const r = await window.moonbase.call(
            'command',
            { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
            crypto.randomUUID(),
          );
          if (!r.ok) throw Error(r.error.message);
          return r.value as RecoveryLoad;
        });
      await expect
        .poll(async () => (await recovery()).state.drafts[0]?.text)
        .toBe('durable dirty text');
      const target = { checkout: (await recovery()).state.checkouts[0], path: 'a.ts' };
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { oldEditorObservers: string[] }).oldEditorObservers.length,
          ),
        )
        .toBeGreaterThan(0);
      const observers = await page.evaluate(
        () => (window as unknown as { oldEditorObservers: string[] }).oldEditorObservers,
      );
      // Hold one actual read helper, in the daemon; normal command cancellation still owns its
      // SIGKILL and close.
      writeFileSync(join(hold, 'arm'), '');
      const waitId = 'old-document-read';
      await page.evaluate(
        ({ target, id }) => {
          void window.moonbase
            .call('command', { operation: 'readFile', input: target }, id)
            .catch(() => {});
        },
        { target, id: waitId },
      );
      await expect
        .poll(() => {
          try {
            return Number(readFileSync(join(hold, 'held'), 'utf8')) || null;
          } catch {
            return null;
          }
        })
        .not.toBeNull();
      const heldPid = Number(readFileSync(join(hold, 'held'), 'utf8'));
      await app.evaluate((_, pid) => void (globalThis.reloadProbe.held = pid), heldPid);
      pids.add(heldPid);
      for (const pid of await app.evaluate(({ app }) =>
        app.getAppMetrics().map((value) => value.pid),
      ))
        pids.add(pid);
      if (mode === 'veto') {
        await editor.focus();
        await editor.press('End');
        await app.evaluate(async ({ BrowserWindow }) => {
          const c = BrowserWindow.getAllWindows()[0].webContents;
          await c.insertText(' fresh');
          await c.executeJavaScript(
            'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
          );
        });
        const outcome = await app.evaluate(
          ({ BrowserWindow }) =>
            new Promise<string>((resolve) => {
              const c = BrowserWindow.getAllWindows()[0].webContents;
              c.once('will-prevent-unload', () => resolve('veto'));
              c.once('did-finish-load', () => resolve('reload'));
              c.reload();
            }),
        );
        expect(outcome).toBe('veto');
        expect(
          await page.evaluate(
            () => (window as unknown as { documentIdentity: string }).documentIdentity,
          ),
        ).toBe(identity);
        const cancelled = await app.evaluate(() => globalThis.reloadProbe.cancels);
        expect([...observers, waitId].some((id) => cancelled.includes(id))).toBe(false);
        await page.evaluate((id) => window.moonbase.cancel(id), waitId);
      } else {
        if (mode === 'crash') {
          await app.evaluate(
            ({ app }, path) => app.setPath('crashDumps', path),
            join(base, 'crash-dumps'),
          );
          await prepareCrashRecovery(app);
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
          );
          await expect
            .poll(() =>
              app.evaluate(
                () =>
                  process.getActiveResourcesInfo().filter((value) => value === 'FSWatcher').length,
              ),
            )
            .toBe(0);
        } else {
          await expect
            .poll(() =>
              app.evaluate(
                ({ BrowserWindow }) =>
                  new Promise<string>((resolve) => {
                    const c = BrowserWindow.getAllWindows()[0].webContents;
                    const finish = (outcome: string) => {
                      c.removeListener('will-prevent-unload', veto);
                      c.removeListener('did-finish-load', done);
                      resolve(outcome);
                    };
                    const veto = () => finish('veto'),
                      done = () => finish('reload');
                    c.once('will-prevent-unload', veto);
                    c.once('did-finish-load', done);
                    c.reload();
                  }),
              ),
            )
            .toBe('reload');
          if (!packaged)
            await expect
              .poll(() =>
                app.evaluate(
                  (_, ids) => ids.every((id) => globalThis.reloadProbe.cancels.includes(id)),
                  [...observers, waitId],
                ),
              )
              .toBe(true);
        }
        await expect
          .poll(() => {
            try {
              process.kill(heldPid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          })
          .toBe(true);
        if (mode === 'crash') await recoverCrashedWorkbench(app);
        await expect
          .poll(() =>
            app.evaluate(async ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `document.querySelector('.view-lines')?.textContent?.replace(/\\u00a0/g, ' ')`,
              ),
            ),
          )
          .toContain('durable dirty text');
        // Same process root keeps its exact approval and accepts the reused read ID after document replacement.
        const saved = await app.evaluate(
          async ({ BrowserWindow }, { target, waitId }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
              `window.moonbase.call('command',{operation:'readFile',input:${JSON.stringify(target)}},'${waitId}')`,
            ),
          { target, waitId },
        );
        expect(saved.ok).toBe(true);
      }
      writeFileSync(
        test.info().outputPath('document.json'),
        JSON.stringify(
          {
            mode,
            identity,
            observers,
            waitId,
            probe: await app.evaluate(() => globalThis.reloadProbe),
            rootPid: child.pid,
            target,
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        writeFileSync(
          test.info().outputPath('final-probe.json'),
          JSON.stringify(await app.evaluate(() => globalThis.reloadProbe), null, 2),
        );
        const held = await app.evaluate(() => globalThis.reloadProbe?.held);
        if (held) {
          pids.add(held);
          try {
            process.kill(held, 'SIGKILL');
          } catch (error) {
            // oxlint-disable-next-line no-unsafe-finally -- Unexpected cleanup failures must remain visible.
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        for (const pid of await app.evaluate(({ app }) =>
          app.getAppMetrics().map((value) => value.pid),
        ))
          pids.add(pid);
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
        await stopDaemon(join(base, 'data', 'daemon-v1'));
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
