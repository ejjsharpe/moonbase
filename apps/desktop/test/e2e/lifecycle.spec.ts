import { waitForExit } from '../fixtures/app-fixture.ts';
import { findTestBun, prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import {
  expectSaveEnabled,
  saveFile,
  prepareCrashRecovery,
  recoverCrashedWorkbench,
  draftsOf,
} from '../fixtures/editor-fixture.ts';
import { createRemoteChat, selectRemoteChat } from '../fixtures/chat-fixture.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { fixture, until } from '../../../../test/chat/tool-fixture.ts';
import { join, resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  callMainScript,
  disconnectHost,
  editorClientId,
  getConnection,
} from '../fixtures/window-ipc-fixture.ts';

const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
for (const mode of ['reload', 'veto', 'fresh-veto', 'crash'])
  test(`native document ${mode.endsWith('veto') ? mode + ' retains' : mode + ' releases'} observers and waits without replacing the root or stopping work`, async () => {
    const veto = mode === 'veto' || mode === 'fresh-veto',
      crash = mode === 'crash';
    const f = await fixture(true);
    let app: ElectronApplication | undefined;
    let child: ReturnType<ElectronApplication['process']> | undefined;
    const pids = new Set<number>();
    try {
      execFileSync('/usr/bin/git', ['-C', f.cwd, 'init', '-q', '-b', 'main']);
      await writeFile(join(f.cwd, 'a.ts'), 'original local text');
      await prepareDaemonData(join(f.directory, 'lifecycle-data'));
      const current = await electron.launch({
        ...(packaged
          ? {
              executablePath:
                process.env.MOONBASE_NATIVE_EXECUTABLE ??
                resolve(
                  `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/MacOS/Moonbase`,
                ),
            }
          : {}),
        args: packaged ? [] : [resolve('test/fixtures/editor-harness.mjs')],
        env: {
          PATH: '/usr/bin:/bin',
          PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
          HOME: process.env.HOME!,
          TMPDIR: process.env.TMPDIR!,
          MOONBASE_USER_DATA: join(f.directory, 'lifecycle-data'),
          MOONBASE_TEST_BUN: findTestBun(),
          MOONBASE_CHAT_CONFIG: f.clientConfig,
          MOONBASE_CHAT_FORWARD_LOG: f.log,
          MOONBASE_CHAT_DROP_SEND: f.drop,
        },
      });
      app = current;
      child = current.process();
      const p = await current.firstWindow(),
        errors: string[] = [];
      p.on('pageerror', (e) => errors.push(e.message));
      for (const pid of await current.evaluate(({ app }) => app.getAppMetrics().map((v) => v.pid)))
        pids.add(pid);
      /** The requests main runs for the document, by procedure (an unpackaged main reports them). */
      const running = () =>
        packaged
          ? Promise.resolve([] as { tag: string; seq: number }[])
          : current.evaluate(() =>
              [...globalThis.desktopTest.active.values()].map(({ tag, seq }) => ({ tag, seq })),
            );
      const interrupted = () =>
        packaged
          ? Promise.resolve([] as number[])
          : current.evaluate(() => globalThis.desktopTest.interrupted);
      await expect(p.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await p.evaluate(() => {
        Object.assign(window, { lifecycleDocument: crypto.randomUUID() });
      });
      await current.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [root],
        })) as typeof dialog.showOpenDialog;
      }, f.cwd);
      await p.getByRole('button', { name: 'Open checkout', exact: true }).click();
      await p.getByRole('treeitem', { name: 'a.ts, untracked', exact: true }).dblclick();
      await p.getByRole('textbox', { name: 'a.ts editor', exact: true }).focus();
      await p.keyboard.press('Meta+a');
      await p.keyboard.insertText('retained local draft at reload');
      const views = p.getByRole('tablist', { name: 'Workbench views', exact: true });
      await views.getByRole('tab', { name: 'Agents', exact: true }).click();
      await selectRemoteChat(p);
      await p.getByRole('button', { name: 'Connect', exact: true }).click();
      await createRemoteChat(p, 'Live lifecycle task');
      await expect(p.getByLabel('Message', { exact: true })).toBeEnabled();
      await f.loseNextSend();
      await p.getByLabel('Message', { exact: true }).fill('one immutable Send');
      await p.getByRole('button', { name: 'Send message', exact: true }).click();
      await until(f.stats, (s) => s.tools === 1);
      await p.getByLabel('Message', { exact: true }).fill('newer chat draft across reload');
      const state = await p.evaluate(() =>
        JSON.parse(localStorage.getItem('moonbase.chat.remote.v2')!),
      );
      const connection = await getConnection(p);
      expect(connection.ok).toBe(true);
      const oldDocument = await p.evaluate(
        () => (window as unknown as { lifecycleDocument: string }).lifecycleDocument,
      );
      // The document's editor and chat watches, which run until it goes.
      const watches = async () => (await running()).filter(({ tag }) => tag.startsWith('watch'));
      if (!packaged)
        await expect
          .poll(async () => (await watches()).some(({ tag }) => tag === 'watchWorkspace'))
          .toBe(true);
      const observed = await watches();
      const active = observed.map(({ seq }) => seq);
      if (!packaged) {
        expect(observed.filter(({ tag }) => tag === 'watchWorkspace')).not.toHaveLength(0);
        expect(observed.filter(({ tag }) => tag !== 'watchWorkspace')).not.toHaveLength(0);
      }
      let waitId = -1;
      if (veto) {
        if (mode === 'veto')
          await p.evaluate(() =>
            localStorage.setItem('moonbase.chat.remote.v2', 'controlled external replacement'),
          );
        await p.getByLabel('Message', { exact: true }).fill('newer unpreserved live draft');
      } else {
        await f.holdReply('getChat');
        await p.evaluate(
          `void ${callMainScript('getChat', { backendId: 'remote', input: { target: state.selected } })}`,
        );
        await until(f.stats, (s) => s.heldReplies.includes('getChat'));
        if (!packaged)
          waitId = (await running()).filter(({ tag }) => tag === 'getChat').at(-1)!.seq;
      }
      if (crash) {
        await mkdir(join(f.directory, 'crash-dumps'));
        await current.evaluate(
          ({ app }, path) => app.setPath('crashDumps', path),
          join(f.directory, 'crash-dumps'),
        );
        await prepareCrashRecovery(current);
        await current.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
        );
        await expect
          .poll(() =>
            current.evaluate(
              () =>
                process.getActiveResourcesInfo().filter((name) => /FSWatcher/.test(name)).length,
            ),
          )
          .toBe(0);
      }
      if (crash) {
        // Playwright retains a crashed Page flag; inspect the recovered real renderer through native APIs.
        await recoverCrashedWorkbench(current);
        const readScript = `(async () => {
          const project = [...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.endsWith(' · main'));
          if (!project) return null;
          project.click();
          if (!document.querySelector('[aria-label="a.ts editor"]')?.getClientRects().length) return null;
          const r = await ${callMainScript('loadRecovery', { clientId: editorClientId })};
          return { recovery: r, saved: JSON.parse(localStorage.getItem("moonbase.chat.remote.v2")), connection: await ${callMainScript('getConnection', { input: {} })} };
        })()`;
        const read = () =>
          current.evaluate(
            async ({ BrowserWindow }, script) =>
              BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script),
            readScript,
          );
        const restored = (await until(read, Boolean)) as {
          recovery: { value: RecoveryLoad };
          saved: { drafts: { text: string }[] };
          connection: unknown;
        };
        expect(draftsOf(restored.recovery.value.state)[0]?.text).toBe(
          'retained local draft at reload',
        );
        expect(restored.saved.drafts[0].text).toBe('newer chat draft across reload');
        expect(restored.connection).toEqual(connection);
        await f.releaseReply();
        await current.evaluate(async ({ BrowserWindow }) => {
          const c = BrowserWindow.getAllWindows()[0].webContents;
          await c.executeJavaScript(`document.querySelector('[aria-label="a.ts editor"]').focus()`);
          c.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['meta'] });
          c.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['meta'] });
        });
        await expect
          .poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8'))
          .toBe('retained local draft at reload');
        await until(
          () =>
            current.evaluate(
              async ({ BrowserWindow }, script) =>
                BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script),
              `(async () => {
                  const reply = await ${callMainScript('loadRecovery', { clientId: editorClientId })};
                  return { reply,
                    alerts: [...document.querySelectorAll('[role="alert"]')].filter(element => element.getClientRects().length && element.textContent.trim()).map(element => element.textContent),
                    statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent)
                  };
                })()`,
            ),
          (value) =>
            value.reply.ok &&
            draftsOf(value.reply.value.state).length === 0 &&
            value.reply.value.errors.length === 0 &&
            value.reply.value.operations.length === 0 &&
            value.alerts.length === 0 &&
            !value.statuses.some((status: string) =>
              /not yet kept for recovery|Keeping edits/.test(status),
            ),
        );
        const stats = await f.stats();
        expect(stats.commands.filter((v) => v === 'sendChat')).toHaveLength(1);
        expect(stats.commands.filter((v) => v === 'stopChat')).toHaveLength(0);
        for (const pid of await current.evaluate(({ app }) =>
          app.getAppMetrics().map((v) => v.pid),
        ))
          pids.add(pid);
        await current.evaluate(({ app }) => app.quit());
        await waitForExit(child);
        app = undefined;
        return;
      }
      if (veto) {
        if (mode === 'fresh-veto') {
          await views.getByRole('tab', { name: / · main$/ }).click();
          await p.getByRole('textbox', { name: 'a.ts editor', exact: true }).focus();
          await p.keyboard.press('End');
        }
        if (mode === 'fresh-veto') {
          await current.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.insertText(' fresh visible tail'),
          );
          await expect(p.locator('.view-lines')).toContainText('fresh visible tail');
        }
        const outcome = await current.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const visible = await contents.executeJavaScript(
            "document.querySelector('.view-lines')?.textContent?.replace(/\\u00a0/g, ' ')",
          );
          return new Promise<{ outcome: string; visible: string }>((resolve) => {
            const finish = (outcome: string) => {
              contents.removeListener('will-prevent-unload', veto);
              contents.removeListener('did-finish-load', loaded);
              resolve({ outcome, visible });
            };
            const veto = () => finish('veto'),
              loaded = () => finish('reload');
            contents.once('will-prevent-unload', veto);
            contents.once('did-finish-load', loaded);
            contents.reload();
          });
        });
        if (mode === 'fresh-veto') expect(outcome.visible).toContain('fresh visible tail');
        expect(outcome.outcome).toBe('veto');
      } else
        await Promise.all([
          p.waitForEvent('domcontentloaded'),
          current.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.reload(),
          ),
        ]);
      if (veto) {
        expect(
          await p.evaluate(
            () => (window as unknown as { lifecycleDocument: string }).lifecycleDocument,
          ),
        ).toBe(oldDocument);
        const cancelled = await interrupted();
        // Chat stays attached while Editor shows, so fresh editing keeps its watches too.
        expect(active.some((id) => cancelled.includes(id))).toBe(false);
        if (mode === 'fresh-veto') {
          await expect(
            p.locator('.view-line').filter({ hasText: 'fresh visible tail' }).first(),
          ).toBeVisible();
          await views.getByRole('tab', { name: 'Agents', exact: true }).click();
        }
        await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
          'newer unpreserved live draft',
        );
      } else {
        await expect(views.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await views.getByRole('tab', { name: / · main$/ }).click();
        await expect(p.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
        if (!crash && !packaged)
          await expect
            .poll(async () => {
              const cancelled = await interrupted();
              return [...active, waitId].every((id) => cancelled.includes(id));
            })
            .toBe(true);
        await f.releaseReply();
        await views.getByRole('tab', { name: 'Agents', exact: true }).click();
        await selectRemoteChat(p);
        await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
          'newer chat draft across reload',
        );
        await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
        expect(await getConnection(p)).toEqual(connection);
        await views.getByRole('tab', { name: / · main$/ }).click();
        await expect(
          p.locator('.view-line').filter({ hasText: 'retained local draft at reload' }).first(),
        ).toBeVisible();
        await saveFile(p);
        await expectSaveEnabled(p, true);
      }
      const stats = await f.stats();
      expect(stats.commands.filter((v) => v === 'sendChat')).toHaveLength(1);
      expect(stats.commands.filter((v) => v === 'stopChat')).toHaveLength(0);
      expect(errors).toEqual([]);
      for (const pid of await current.evaluate(({ app }) => app.getAppMetrics().map((v) => v.pid)))
        pids.add(pid);
      if (veto) {
        await disconnectHost(p);
        await current.evaluate(({ app }) => app.exit(0));
      } else await current.evaluate(({ app }) => app.quit());
      await waitForExit(child);
      app = undefined;
    } finally {
      try {
        await f.releaseReply();
      } finally {
        try {
          if (app && child?.exitCode === null && child?.signalCode === null) {
            const window = app.windows()[0];
            if (window) await disconnectHost(window).catch(() => {});
            await app.evaluate(({ app }) => app.exit(0));
            await waitForExit(child);
            const records = (await readFile(f.log, 'utf8').catch(() => ''))
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { pid: number });
            for (const pid of new Set(records.map((record) => record.pid))) {
              try {
                process.kill(-pid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
                // oxlint-disable-next-line no-unsafe-finally -- Unexpected cleanup failures must remain visible.
                throw error;
              }
              const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
                encoding: 'utf8',
              });
              if (!command.includes(join(f.directory, 'controlled-ssh')))
                // oxlint-disable-next-line no-unsafe-finally -- Never signal a process group whose fixture ownership cannot be verified.
                throw Error('Refusing to signal an unverified group.');
              process.kill(-pid, 'SIGTERM');
              await until(async () => {
                try {
                  process.kill(-pid, 0);
                  return false;
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === 'ESRCH';
                }
              }, Boolean);
            }
          }
        } finally {
          // A daemon outlives its app: stop this profile's before the fixture goes.
          await stopDaemon(join(f.directory, 'lifecycle-data', 'daemon-v1'));
          await f.close();
          for (const pid of pids)
            await until(async () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (e) {
                return (e as NodeJS.ErrnoException).code === 'ESRCH';
              }
            }, Boolean);
        }
      }
    }
  });
