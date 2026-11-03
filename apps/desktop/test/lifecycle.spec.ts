import { selectRemoteChat } from './chat-target.ts';
import { prepareCrashRecovery, recoverCrashedWorkbench } from './editor-regressions.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { fixture, until } from '../../../tests/chat/tool-fixture.ts';
import { join, resolve } from 'node:path';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

declare global {
  var task08Cancels: string[];
}
const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const evidence = resolve(process.env.MOONBASE_NATIVE_OUTPUT ?? 'test-results', 'lifecycle');
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
        args: packaged ? [] : [resolve('test/harness.mjs')],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: process.env.HOME!,
          TMPDIR: process.env.TMPDIR!,
          MOONBASE_USER_DATA: join(f.directory, 'lifecycle-data'),
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
      await current.evaluate(() => {
        globalThis.task08Cancels = [];
        if (globalThis.desktopTest)
          Object.defineProperty(globalThis, 'task08Cancels', {
            configurable: true,
            get: () => [
              ...globalThis.desktopTest.cancelIds.map((id) => 'moonbase:' + id),
              ...globalThis.desktopTest.chatCancelIds.map((id) => 'moonbase-chat:' + id),
            ],
          });
      });
      await expect(p.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
      await p.evaluate(() => {
        const ids = { editor: [] as string[], chat: [] as string[] };
        window.moonbase.events((id) => {
          if (!ids.editor.includes(id)) ids.editor.push(id);
        });
        window.moonbaseChat.events((id) => {
          if (!ids.chat.includes(id)) ids.chat.push(id);
        });
        Object.assign(window, { task08Observed: ids, task08Document: crypto.randomUUID() });
      });
      await current.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [root],
        })) as typeof dialog.showOpenDialog;
      }, f.cwd);
      await p.getByRole('button', { name: 'Open checkout', exact: true }).click();
      await p.getByRole('treeitem', { name: 'a.ts', exact: true }).dblclick();
      await p.getByRole('textbox', { name: 'a.ts editor', exact: true }).focus();
      await p.keyboard.press('Meta+a');
      await p.keyboard.insertText('retained local draft at reload');
      const views = p.getByRole('tablist', { name: 'Workbench views', exact: true });
      await views.getByRole('tab', { name: 'Chat', exact: true }).click();
      await selectRemoteChat(p);
      await p.getByRole('button', { name: 'Connect', exact: true }).click();
      await p.getByLabel('New saved chat').fill('Live lifecycle task');
      await p.getByRole('button', { name: 'Create chat', exact: true }).click();
      await expect(p.getByLabel('Message', { exact: true })).toBeEnabled();
      await f.loseNextSend();
      await p.getByLabel('Message', { exact: true }).fill('one immutable Send');
      await p.getByRole('button', { name: 'Send message', exact: true }).click();
      await until(f.stats, (s) => s.tools === 1);
      await p.getByLabel('Message', { exact: true }).fill('newer chat draft across reload');
      const state = await p.evaluate(() => JSON.parse(localStorage.getItem('moonbase.chat.v1')!));
      const connection = await p.evaluate(() =>
        window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
      );
      expect(connection.ok).toBe(true);
      const oldDocument = await p.evaluate(
        () => (window as unknown as { task08Document: string }).task08Document,
      );
      await expect
        .poll(() =>
          p.evaluate(
            () =>
              (window as unknown as { task08Observed: { editor: string[]; chat: string[] } })
                .task08Observed.editor.length,
          ),
        )
        .toBeGreaterThan(0);
      const observed = await p.evaluate(
        () =>
          (window as unknown as { task08Observed: { editor: string[]; chat: string[] } })
            .task08Observed,
      );
      const previousCancels = await current.evaluate(() => globalThis.task08Cancels);
      const active = [
        ...observed.editor.map((id) => 'moonbase:' + id),
        ...observed.chat.map((id) => 'moonbase-chat:' + id),
      ].filter((id) => !previousCancels.includes(id));
      expect(active.filter((v) => v.startsWith('moonbase:'))).not.toHaveLength(0);
      expect(active.filter((v) => v.startsWith('moonbase-chat:'))).not.toHaveLength(0);
      const waitId = randomUUID();
      if (veto) {
        if (mode === 'veto')
          await p.evaluate(() =>
            localStorage.setItem('moonbase.chat.v1', 'controlled external replacement'),
          );
        await p.getByLabel('Message', { exact: true }).fill('newer unpreserved live draft');
      } else {
        await f.holdReply('getChat');
        await p.evaluate(
          ({ target, id }) => {
            void window.moonbaseChat.call('chat', 'getChat', { target }, id);
          },
          { target: state.selected, id: waitId },
        );
        await until(f.stats, (s) => s.heldReplies.includes('getChat'));
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
        const read = () =>
          current.evaluate(async ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(async () => {
          if (!document.querySelector('[aria-label="a.ts editor"]')) return null;
          const r = await window.moonbase.call("command", { operation: "loadRecovery", input: { clientId: window.moonbase.clientId } }, crypto.randomUUID());
          return { recovery: r, saved: JSON.parse(localStorage.getItem("moonbase.chat.v1")), connection: await window.moonbaseChat.call("connection", "getConnection", {}, crypto.randomUUID()) };
        })()`),
          );
        const restored = (await until(read, Boolean)) as {
          recovery: { value: RecoveryLoad };
          saved: { drafts: { text: string }[] };
          connection: unknown;
        };
        expect(restored.recovery.value.state.drafts[0].text).toBe('retained local draft at reload');
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
            current.evaluate(async ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `(() => { const b = [...document.querySelectorAll("button")].find(b=>b.textContent==="Save"); return !!b && !b.disabled; })()`,
              ),
            ),
          Boolean,
        );
        const stats = await f.stats();
        expect(stats.commands.filter((v) => v === 'sendChat')).toHaveLength(1);
        expect(stats.commands.filter((v) => v === 'stopChat')).toHaveLength(0);
        for (const pid of await current.evaluate(({ app }) =>
          app.getAppMetrics().map((v) => v.pid),
        ))
          pids.add(pid);
        await mkdir(evidence, { recursive: true });
        await writeFile(
          join(evidence, `${packaged ? 'package' : 'source'}-crash.json`),
          JSON.stringify({ restored, stats, oldWatchersReleased: true }, null, 2),
        );
        await current.evaluate(({ app }) => app.quit());
        await until(async () => child!.exitCode !== null || child!.signalCode !== null, Boolean);
        app = undefined;
        return;
      }
      if (veto) {
        if (mode === 'fresh-veto') {
          await views.getByRole('tab', { name: / · main$/ }).click();
          await p.getByRole('textbox', { name: 'a.ts editor', exact: true }).focus();
          await p.keyboard.press('End');
        }
        const outcome = await current.evaluate(async ({ BrowserWindow }, fresh) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          if (fresh) {
            await contents.insertText(' fresh visible tail');
            await contents.executeJavaScript(
              'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
            );
          }
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
        }, mode === 'fresh-veto');
        if (mode === 'fresh-veto') expect(outcome.visible).toContain('fresh visible tail');
        expect(outcome.outcome).toBe('veto');
      } else
        await Promise.all([
          p.waitForEvent('domcontentloaded'),
          current.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.reload(),
          ),
        ]);
      await p.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, `${packaged ? 'package' : 'source'}-${mode}-before-check.json`),
        JSON.stringify(
          {
            mode,
            active,
            waitId: veto ? null : waitId,
            cancelled: await current.evaluate(() => globalThis.task08Cancels),
          },
          null,
          2,
        ),
      );
      if (veto) {
        expect(
          await p.evaluate(() => (window as unknown as { task08Document: string }).task08Document),
        ).toBe(oldDocument);
        const cancelled = await current.evaluate(() => globalThis.task08Cancels);
        // Fresh editing switches to Editor, which deliberately detaches Chat before the reload veto.
        const retained =
          mode === 'fresh-veto' ? active.filter((id) => id.startsWith('moonbase:')) : active;
        expect(retained.some((id) => cancelled.includes(id))).toBe(false);
        if (mode === 'fresh-veto') {
          await expect(
            p.locator('.view-line').filter({ hasText: 'fresh visible tail' }).first(),
          ).toBeVisible();
          await views.getByRole('tab', { name: 'Chat', exact: true }).click();
        }
        await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
          'newer unpreserved live draft',
        );
      } else {
        await expect(p.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
        if (!crash && !packaged)
          await expect
            .poll(() =>
              current.evaluate(
                (_, ids) => ids.every((id) => globalThis.task08Cancels.includes(id)),
                [...active, 'moonbase-chat:' + waitId],
              ),
            )
            .toBe(true);
        await f.releaseReply();
        await views.getByRole('tab', { name: 'Chat', exact: true }).click();
        await selectRemoteChat(p);
        await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
          'newer chat draft across reload',
        );
        await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
        const after = await p.evaluate(() =>
          window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
        );
        expect(after).toEqual(connection);
        await views.getByRole('tab', { name: / · main$/ }).click();
        await expect(
          p.locator('.view-line').filter({ hasText: 'retained local draft at reload' }).first(),
        ).toBeVisible();
        await p.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(p.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      }
      const stats = await f.stats();
      expect(stats.commands.filter((v) => v === 'sendChat')).toHaveLength(1);
      expect(stats.commands.filter((v) => v === 'stopChat')).toHaveLength(0);
      expect(errors).toEqual([]);
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, `${packaged ? 'package' : 'source'}-${mode}.json`),
        JSON.stringify(
          {
            mode,
            active,
            waitId: veto ? null : waitId,
            cancelled: await current.evaluate(() => globalThis.task08Cancels),
            connection,
            stats,
          },
          null,
          2,
        ),
      );
      for (const pid of await current.evaluate(({ app }) => app.getAppMetrics().map((v) => v.pid)))
        pids.add(pid);
      if (veto) {
        await p.evaluate(async () => {
          const r = await window.moonbaseChat.call(
            'connection',
            'getConnection',
            {},
            crypto.randomUUID(),
          );
          if (r.ok)
            await window.moonbaseChat.call(
              'connection',
              'disconnect',
              { connectionId: (r.value as { connectionId: string }).connectionId },
              crypto.randomUUID(),
            );
        });
        await current.evaluate(({ app }) => app.exit(0));
      } else await current.evaluate(({ app }) => app.quit());
      await until(async () => child!.exitCode !== null || child!.signalCode !== null, Boolean);
      app = undefined;
    } catch (error) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, `${packaged ? 'package' : 'source'}-${mode}-failure.txt`),
        String(error),
      );
      throw error;
    } finally {
      try {
        await f.releaseReply();
      } finally {
        try {
          if (app && child?.exitCode === null && child?.signalCode === null) {
            await app
              .windows()[0]
              .evaluate(async () => {
                const r = await window.moonbaseChat.call(
                  'connection',
                  'getConnection',
                  {},
                  crypto.randomUUID(),
                );
                if (r.ok && (r.value as { connectionId: string | null }).connectionId)
                  await window.moonbaseChat.call(
                    'connection',
                    'disconnect',
                    { connectionId: (r.value as { connectionId: string }).connectionId },
                    crypto.randomUUID(),
                  );
              })
              .catch(() => {});
            await app.evaluate(({ app }) => app.exit(0));
            await until(
              async () => child!.exitCode !== null || child!.signalCode !== null,
              Boolean,
            );
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
              await appendFile(
                join(evidence, 'forced-failure-cleanup.jsonl'),
                JSON.stringify({ pid, command, signal: 'TERM', confirmedAbsent: true }) + '\n',
              );
            }
          }
        } finally {
          const cleanup = await f.close();
          for (const pid of pids)
            await until(async () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (e) {
                return (e as NodeJS.ErrnoException).code === 'ESRCH';
              }
            }, Boolean);
          await mkdir(evidence, { recursive: true });
          await appendFile(
            join(evidence, 'cleanup.jsonl'),
            JSON.stringify({ packaged, mode, veto, pids: [...pids], absent: true, ...cleanup }) +
              '\n',
          );
        }
      }
    }
  });
