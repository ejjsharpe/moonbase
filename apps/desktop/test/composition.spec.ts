import { expectSaveEnabled, saveFile, captureNative } from './editor-regressions.ts';
import { createRemoteChat, selectRemoteChat } from './chat-target.ts';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { fixture, until } from '../../../tests/chat/tool-fixture.ts';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const children = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>();
const output = resolve(process.env.MOONBASE_NATIVE_OUTPUT ?? 'test-results', 'composition');
async function launch(
  f: Fixture,
  data = 'desktop-data',
  startupFailure?: 'editor' | 'chat-context',
) {
  const app = await electron.launch({
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
      MOONBASE_USER_DATA: join(f.directory, data),
      MOONBASE_CHAT_CONFIG: f.clientConfig,
      ...(startupFailure ? { MOONBASE_TEST_STARTUP_FAILURE: startupFailure } : {}),
      ...(process.env.MOONBASE_TEST_MAIN
        ? { MOONBASE_TEST_MAIN: process.env.MOONBASE_TEST_MAIN }
        : {}),
      MOONBASE_CHAT_FORWARD_LOG: f.log,
      MOONBASE_CHAT_DROP_SEND: f.drop,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  children.set(app, app.process());
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await expect(
      startupFailure === 'editor'
        ? page.getByRole('alert', { name: 'Workbench startup failed' })
        : page.getByRole('button', { name: 'Open checkout', exact: true }),
    ).toBeVisible();
  } catch (error) {
    await stop(app, true);
    throw error;
  }
  return { app, page, errors };
}
async function setup(f: Fixture) {
  // Deliberately equal local root / remote cwd strings, still different authorities.
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      f.cwd,
      '-c',
      'user.name=Composition Test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  await writeFile(join(f.cwd, 'a.ts'), 'const original = 1;\n');
  await writeFile(join(f.cwd, 'b.ts'), 'const sibling = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'Controlled composition fixture');
}
const editor = (p: Page) => p.getByRole('textbox', { name: 'a.ts editor', exact: true });
const tab = (p: Page, view: string) =>
  p
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .getByRole('tab', { name: view, exact: true });
const projectTab = (p: Page) =>
  p
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .getByRole('tab', { name: / · main$/ });
async function local(p: Page, app: ElectronApplication, f: Fixture) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, f.cwd);
  await p.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await p.getByRole('treeitem', { name: 'a.ts', exact: true }).dblclick();
  await editor(p).focus();
  await editor(p).press('Meta+a');
  await editor(p).pressSequentially('local dirty draft');
}
async function connect(p: Page) {
  await tab(p, 'Agents').click();
  await selectRemoteChat(p);
  await p.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(p.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
  const details = p.getByText('Connection details', { exact: true });
  if (!(await details.evaluate((element) => element.parentElement!.hasAttribute('open'))))
    await details.click();
}
async function create(p: Page, title: string) {
  await createRemoteChat(p, title);
  await expect(p.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(p.getByLabel('Message', { exact: true })).toBeEnabled();
}

const reloadOutcome = (app: ElectronApplication) =>
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
async function saved(p: Page) {
  return p.evaluate(() => JSON.parse(localStorage.getItem('moonbase.chat.v1')!));
}
async function recovery(p: Page) {
  return p
    .evaluate(async () => {
      const r = await window.moonbase.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
        crypto.randomUUID(),
      );
      if (!r.ok) throw Error(r.error.message);
      return JSON.stringify(r.value);
    })
    .then(JSON.parse);
}
async function screen(app: ElectronApplication, p: Page, name: string) {
  await captureNative(app, p, join(output, `${packaged ? 'package' : 'source'}-${name}.png`));
}
async function stop(app: ElectronApplication, fault = false) {
  const child = children.get(app)!;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid));
  if (fault) {
    await app
      .windows()[0]
      .evaluate(async () => {
        const r = await window.moonbaseChat.call(
          'connection',
          'getConnection',
          {},
          crypto.randomUUID(),
        );
        if (r.ok && (r.value as { connectionId: string }).connectionId)
          await window.moonbaseChat.call(
            'connection',
            'disconnect',
            { connectionId: (r.value as { connectionId: string }).connectionId },
            crypto.randomUUID(),
          );
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.exit(0));
  } else await app.evaluate(({ app }) => app.quit());
  await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
  for (const pid of pids)
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, Boolean);
  await mkdir(output, { recursive: true });
  await appendFile(
    join(output, 'cleanup.jsonl'),
    JSON.stringify({
      phase: packaged ? 'package' : 'source',
      pids,
      absent: true,
      faultTeardown: fault,
    }) + '\n',
  );
}
async function close(f: Fixture) {
  const report = await f.close();
  await mkdir(output, { recursive: true });
  await appendFile(join(output, 'cleanup.jsonl'), JSON.stringify(report) + '\n');
}

test('dirty editor/live chat, two drafts, no-resend reconnect, view close and client Quit stay independent', async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await setup(f);
    const baseline = await f.stats();
    const { app, page: p, errors } = await launch(f);
    current = app;
    expect((await f.stats()).commands).toEqual(baseline.commands);
    expect((await f.stats()).calls).toBe(0);
    expect(await readFile(f.log, 'utf8').catch(() => null)).toBeNull();
    await local(p, app, f);
    await connect(p);
    await create(p, 'First remote chat');
    await f.loseNextSend();
    await p.getByLabel('Message', { exact: true }).fill('one deliberately admitted message');
    await p.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await f.stats()).tools).toBe(1);
    await expect
      .poll(async () =>
        (await saved(p)).pending.some((v: { operation: string }) => v.operation === 'sendChat'),
      )
      .toBe(true);
    const original = (await saved(p)).pending.find(
      (v: { operation: string }) => v.operation === 'sendChat',
    );
    await p.getByLabel('Message', { exact: true }).fill('first independent newer draft');
    await tab(p, 'Agents').focus();
    await p.keyboard.press('ArrowRight');
    await expect(projectTab(p)).toBeFocused();
    await p.keyboard.press('Enter');
    await p.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await screen(app, p, 'keyboard-activation');
    await writeFile(
      join(output, 'keyboard-focus.json'),
      JSON.stringify(
        await p.evaluate(() => ({
          active: {
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute('aria-label'),
            role: document.activeElement?.getAttribute('role'),
          },
          text: document.querySelector('.view-lines')?.textContent,
        })),
        null,
        2,
      ),
    );
    await expect(projectTab(p)).toBeFocused();
    await expect(projectTab(p)).toHaveAttribute('aria-selected', 'true');
    const editorHasFocus = () =>
      p.evaluate(() => !!document.activeElement?.closest('[aria-label="Moonbase editor"]'));
    for (let step = 0; step < 24 && !(await editorHasFocus()); step++)
      await p.keyboard.press('Tab');
    expect(await editorHasFocus()).toBe(true);
    await p.keyboard.press('Meta+p');
    const lookup = p.getByRole('dialog').getByRole('combobox');
    await lookup.fill('a.ts');
    await lookup.press('Enter');
    await expect(editor(p)).toBeFocused();
    await editor(p).press('End');
    await editor(p).pressSequentially(' + live tool editing');
    await expect
      .poll(async () => (await recovery(p)).state.drafts[0]?.text)
      .toBe('local dirty draft + live tool editing');
    // Remote cwd is never authority to the local editor, even with an equal root string.
    const rejected = await p.evaluate(async (host) => {
      const r = await window.moonbase.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
        crypto.randomUUID(),
      );
      if (!r.ok) throw Error(r.error.message);
      const local = (r.value as { state: { checkouts: CheckoutTarget[] } }).state.checkouts[0];
      return window.moonbase.call(
        'command',
        { operation: 'readFile', input: { checkout: { ...local, hostId: host }, path: 'a.ts' } },
        crypto.randomUUID(),
      );
    }, f.session.host.hostId);
    expect(rejected).toMatchObject({ ok: false, error: { code: 'Unauthorized' } });
    expect(await readFile(join(f.cwd, 'a.ts'), 'utf8')).toContain('original');
    await screen(app, p, 'dirty-editor');
    await tab(p, 'Agents').click();
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'first independent newer draft',
    );
    await create(p, 'Second remote chat');
    await p.getByLabel('Message', { exact: true }).fill('second independent draft');
    await p.getByRole('button', { name: 'First remote chat', exact: false }).click();
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'first independent newer draft',
    );
    const priorWatches = packaged
      ? null
      : await app.evaluate(() => ({
          editor: globalThis.desktopTest.calls.filter((v) => v.method === 'watch').map((v) => v.id),
          chat: globalThis.desktopTest.chatCalls
            .filter((v) => v.kind.startsWith('watch-'))
            .map((v) => v.id),
        }));
    const reloadOutcomes: string[] = [];
    try {
      await expect
        .poll(async () => {
          const outcome = await reloadOutcome(app);
          reloadOutcomes.push(outcome);
          return outcome;
        })
        .toBe('reload');
    } finally {
      await writeFile(join(output, 'durable-reload-outcomes.json'), JSON.stringify(reloadOutcomes));
    }
    await projectTab(p).click();
    await expect(editor(p)).toBeVisible();
    await expect(
      p.locator('.view-line').filter({ hasText: 'local dirty draft + live tool editing' }).first(),
    ).toBeVisible();
    if (priorWatches)
      await expect
        .poll(() =>
          app.evaluate(
            (_, ids) => ({
              editor: ids.editor.every((id) => globalThis.desktopTest.cancelIds.includes(id)),
              chat: ids.chat.every((id) => globalThis.desktopTest.chatCancelIds.includes(id)),
            }),
            priorWatches,
          ),
        )
        .toEqual({ editor: true, chat: true });
    await screen(app, p, 'restored-dirty-editor');
    await editor(p).focus(); // Establish focus in the NEW document before testing navigation restoration.
    await tab(p, 'Agents').click();
    await selectRemoteChat(p);
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'first independent newer draft',
    );
    expect((await f.stats()).commands.filter((v) => v === 'sendChat')).toHaveLength(1);
    await p.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await p.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    expect((await f.stats()).commands.filter((v) => v === 'sendChat')).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (await saved(p)).pending.filter((v: { operation: string }) => v.operation === 'sendChat')
            .length,
      )
      .toBe(0);
    expect((await f.stats()).mutations.find((v) => v.operation === 'sendChat')!.input).toEqual(
      original.input,
    );
    await p.getByRole('button', { name: 'Close view', exact: true }).click();
    expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(0);
    await p.getByRole('button', { name: 'First remote chat', exact: false }).click();
    await projectTab(p).click();
    await expect(editor(p)).toBeFocused();
    await p.getByRole('button', { name: 'Close a.ts', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await saveFile(p);
    await expect
      .poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8'))
      .toBe('local dirty draft + live tool editing');
    await p.getByRole('button', { name: 'Close a.ts', exact: true }).click();
    await expect(editor(p)).toHaveCount(0);
    expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(0);
    await tab(p, 'Agents').click();
    await p.getByRole('button', { name: 'Second remote chat', exact: false }).click();
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue('second independent draft');
    await p.getByLabel('Message', { exact: true }).fill('latest second draft for restart');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    ).toBe(false);
    await app.evaluate(({ app }) => app.emit('activate', {} as never, false));
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'latest second draft for restart',
    );
    await stop(app);
    current = undefined;
    expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(0); // Quit didn't Stop/shut down the host.
    const second = await launch(f);
    current = second.app;
    await connect(second.page);
    await expect(second.page.getByLabel('Message', { exact: true })).toHaveValue(
      'latest second draft for restart',
    );
    expect((await f.stats()).commands.filter((v) => v === 'sendChat')).toHaveLength(1);
    await second.page.getByRole('button', { name: 'First remote chat', exact: false }).click();
    await expect(second.page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(second.page.getByLabel('Message', { exact: true })).toHaveValue(
      'first independent newer draft',
    );
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
    await stop(second.app);
    current = undefined;
  } finally {
    if (current) await stop(current, true);
    await close(f);
  }
});

for (const change of ['external', 'write-failure'])
  test(`chat ${change} vetoes Quit before any editor Discard or Save`, async () => {
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    try {
      await setup(f);
      const { app, page: p, errors } = await launch(f);
      current = app;
      await local(p, app, f);
      await connect(p);
      await create(p, 'Preservation fence');
      await p.getByLabel('Message', { exact: true }).fill('preserved chat draft');
      const prior = await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'));
      await p.evaluate((change) => {
        if (change === 'external') localStorage.setItem('moonbase.chat.v1', 'external bytes');
        else
          Storage.prototype.setItem = () => {
            throw new DOMException('full controlled storage', 'QuotaExceededError');
          };
      }, change);
      await p.getByLabel('Message', { exact: true }).fill('newer visible unsaved chat draft');
      await app.evaluate(({ app }) => app.quit());
      await expect(p.getByRole('alert').first()).toContainText('preserv');
      await expect(p.getByRole('dialog')).toHaveCount(0);
      expect(children.get(app)!.exitCode).toBeNull();
      await projectTab(p).click();
      await expect(editor(p)).toBeVisible();
      await expect(
        p.locator('.view-line').filter({ hasText: 'local dirty draft' }).first(),
      ).toBeVisible();
      await expect
        .poll(async () => (await recovery(p)).state.drafts[0]?.text)
        .toBe('local dirty draft');
      const bytes = await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'));
      expect(bytes).toBe(change === 'external' ? 'external bytes' : prior);
      expect(
        (await f.stats()).commands.filter((v) => ['sendChat', 'stopChat'].includes(v)),
      ).toEqual([]);
      expect(errors).toEqual([]);
      await stop(app, true);
      current = undefined;
    } finally {
      if (current) await stop(current, true);
      await close(f);
    }
  });

test('native 200% normal/constrained live chat keeps wheel/Tab Stop and Send reachable beside a dirty editor', async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await setup(f);
    const { app, page: p, errors } = await launch(f);
    current = app;
    await local(p, app, f);
    await connect(p);
    await create(p, 'Long remote context ' + 'retained descriptive host folder '.repeat(5));
    await p.getByLabel('Message', { exact: true }).fill('one remote running task at native zoom');
    await p.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await f.stats()).tools).toBe(1);
    await p.getByLabel('Message', { exact: true }).fill('newer independent zoom draft');
    await screen(app, p, 'live-chat-normal');
    for (const width of [1180, 700]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(width, width === 1180 ? 820 : 650);
        w.webContents.setZoomFactor(2);
      }, width);
      await p.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
      const main = p.locator('main');
      await main.hover();
      await p.mouse.wheel(0, 10000);
      await p.getByLabel('Message', { exact: true }).focus();
      await p.keyboard.press('Tab');
      await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeFocused();
      try {
        await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
      } catch (error) {
        await writeFile(
          join(output, `zoom-failure-${width}.json`),
          JSON.stringify(
            await p.getByRole('button', { name: 'Stop', exact: true }).evaluate((button) => {
              const parents = [];
              let element: Element | null = button;
              while (element) {
                const style = getComputedStyle(element);
                parents.push({
                  tag: element.tagName,
                  role: element.getAttribute('role'),
                  rect: element.getBoundingClientRect().toJSON(),
                  height: element.clientHeight,
                  scroll: element.scrollTop,
                  scrollHeight: element.scrollHeight,
                  overflow: style.overflowY,
                  minHeight: style.minHeight,
                  flex: style.flex,
                });
                element = element.parentElement;
              }
              return { width: innerWidth, height: innerHeight, parents };
            }),
            null,
            2,
          ),
        );
        await screen(app, p, `zoom-failed-${width}`);
        throw error;
      }
      await p.keyboard.press('Tab');
      await expect(p.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
      await expect(p.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
      const geometry = await p
        .getByRole('button', { name: 'Send message', exact: true })
        .evaluate((e) => {
          const r = e.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            width: innerWidth,
            height: innerHeight,
          };
        });
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      await screen(app, p, `zoom-${width}`);
    }
    await p.keyboard.press('Shift+Tab');
    await p.keyboard.press('Enter');
    await expect
      .poll(async () => (await f.stats()).commands.filter((v) => v === 'stopChat').length)
      .toBe(1);
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'newer independent zoom draft',
    );
    await p.getByLabel('Message', { exact: true }).press('Control+Enter');
    await expect
      .poll(async () => (await f.stats()).commands.filter((v) => v === 'sendChat').length)
      .toBe(2);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );
    await projectTab(p).click();
    await expect(editor(p)).toBeFocused();
    await editor(p).press('End');
    await editor(p).pressSequentially(' after zoom');
    await saveFile(p);
    await expect
      .poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8'))
      .toBe('local dirty draft after zoom');
    expect(errors).toEqual([]);
    await stop(app);
    current = undefined;
  } finally {
    if (current) await stop(current, true);
    await close(f);
  }
});

test('captured Quit keeps chat/newer drafts and editor conflicts usable; Cancel then Save/Discard commits only consented work', async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await setup(f);
    const { app, page: p, errors } = await launch(f);
    current = app;
    await local(p, app, f);
    await connect(p);
    await create(p, 'Quit with independent chat');
    await p.getByLabel('Message', { exact: true }).fill('before Quit');
    await projectTab(p).click();
    await writeFile(join(f.cwd, 'a.ts'), 'external conflicting change');
    await app.evaluate(({ app }) => app.quit());
    await p.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      p.getByRole('button', { name: 'Overwrite observed version', exact: true }),
    ).toBeVisible();
    await p.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(children.get(app)!.exitCode).toBeNull();
    await expect(editor(p)).toBeVisible();
    await tab(p, 'Agents').click();
    await p.getByLabel('Message', { exact: true }).fill('newer draft after cancelled Quit');
    await projectTab(p).click();
    await app.evaluate(({ app }) => app.quit());
    await p.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await until(async () => children.get(app)!.exitCode !== null, Boolean);
    current = undefined;
    expect(await readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('external conflicting change');
    const next = await launch(f);
    current = next.app;
    await expect.poll(async () => (await recovery(next.page)).state.drafts.length).toBe(0);
    await connect(next.page);
    await expect(next.page.getByLabel('Message', { exact: true })).toHaveValue(
      'newer draft after cancelled Quit',
    );
    expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(0);
    expect(errors).toEqual([]);
    await stop(next.app);
    current = undefined;
  } finally {
    if (current) await stop(current, true);
    await close(f);
  }
});

if (!packaged)
  test('held Save and final publication do not globally block Send/status/Stop; uncertain Quit retains exact publication', async () => {
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    try {
      await setup(f);
      const { app, page: p, errors } = await launch(f);
      current = app;
      await local(p, app, f);
      await connect(p);
      await create(p, 'Independent long waits');
      await projectTab(p).click();
      await app.evaluate(() => {
        globalThis.desktopTest.held = 'saveFile';
      });
      await saveFile(p);
      await expect.poll(() => app.evaluate(() => globalThis.desktopTest.held)).toBe('waiting');
      await tab(p, 'Agents').click();
      await p.getByLabel('Message', { exact: true }).fill('task while Save reply waits');
      await p.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(async () => (await f.stats()).tools).toBe(1);
      await p.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect
        .poll(async () => (await f.stats()).commands.filter((v) => v === 'stopChat').length)
        .toBe(1);
      const status = await p.evaluate(() =>
        window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
      );
      expect(status.ok).toBe(true);
      await app.evaluate(() => globalThis.desktopTest.release());
      await projectTab(p).click();
      await expectSaveEnabled(p, true);
      await editor(p).focus();
      await editor(p).press('End');
      await editor(p).pressSequentially(' newer pending recovery');
      await expect
        .poll(async () => (await recovery(p)).state.drafts[0]?.text)
        .toContain('newer pending recovery');
      await app.evaluate(() => {
        globalThis.desktopTest.fault = 'final-publication';
      });
      await app.evaluate(({ app }) => app.quit());
      await p.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
      await expect(
        p.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
      ).toBeVisible();
      expect((await recovery(p)).state.drafts).toEqual([]);
      await expect(editor(p)).toBeVisible();
      expect(children.get(app)!.exitCode).toBeNull();
      await tab(p, 'Agents').click();
      await p
        .getByLabel('Message', { exact: true })
        .fill('latest chat while editor publication unknown');
      await projectTab(p).click();
      await app.evaluate(() => {
        globalThis.desktopTest.noStatus = false;
      });
      await p.getByRole('button', { name: 'Resolve recovery publication', exact: true }).click();
      await expect(
        p.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
      ).toHaveCount(0);
      expect(await readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('local dirty draft');
      expect(errors).toEqual([]);
      await stop(app);
      current = undefined;
      const next = await launch(f);
      current = next.app;
      await connect(next.page);
      await expect(next.page.getByLabel('Message', { exact: true })).toHaveValue(
        'latest chat while editor publication unknown',
      );
      expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(1);
      await stop(next.app);
      current = undefined;
    } finally {
      if (current) await stop(current, true);
      await close(f);
    }
  });

test('held admitted Send leaves local Save/read/status and exact Stop independently responsive', async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await setup(f);
    const { app, page: p, errors } = await launch(f);
    current = app;
    await local(p, app, f);
    await connect(p);
    await create(p, 'Send wait does not own files');
    await f.holdReply('sendChat');
    await p.getByLabel('Message', { exact: true }).fill('captured held Send');
    await p.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(f.stats, (s) => s.heldReplies.includes('sendChat'));
    const original = (await saved(p)).pending.find(
      (v: { operation: string }) => v.operation === 'sendChat',
    );
    await p.getByLabel('Message', { exact: true }).fill('newer draft while original waits');
    await projectTab(p).click();
    await saveFile(p);
    await expect.poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('local dirty draft');
    expect((await recovery(p)).state.checkouts).toHaveLength(1);
    await tab(p, 'Agents').click();
    const status = await p.evaluate(() =>
      window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
    );
    expect(status.ok).toBe(true);
    await p.getByRole('button', { name: 'Stop', exact: true }).click();
    await until(f.stats, (s) => s.mutations.some((v) => v.operation === 'stopChat'));
    const stopped = (await f.stats()).mutations.find((v) => v.operation === 'stopChat')!.input as {
      stop: { target: unknown };
    };
    expect(stopped.stop.target).toEqual(original.input.target);
    await f.releaseReply();
    await expect
      .poll(async () =>
        (await saved(p)).pending.some((v: { operation: string }) => v.operation === 'sendChat'),
      )
      .toBe(false);
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'newer draft while original waits',
    );
    expect((await f.stats()).commands.filter((v) => v === 'sendChat')).toHaveLength(1);
    expect(errors).toEqual([]);
    await stop(app);
    current = undefined;
  } finally {
    try {
      await f.releaseReply();
    } finally {
      try {
        if (current) await stop(current, true);
      } finally {
        await close(f);
      }
    }
  }
});

test('composed IPC rejects foreign frames/hosts and extra/prototype operations before dispatch or local IO', async () => {
  const f = await fixture();
  let current: ElectronApplication | undefined;
  try {
    const baseline = await f.stats();
    const { app, page: p, errors } = await launch(f);
    current = app;
    const rejected = await p.evaluate(async () => {
      const context = await window.moonbaseChat.context();
      const results = [];
      for (const [op, input] of [
        ['__proto__', {}],
        ['getChatHost', { host: { ...context.host, hostId: 'foreign' } }],
        ['getChatHost', { host: context.host, extra: true }],
      ] as const)
        results.push(await window.moonbaseChat.call('chat', op, input, crypto.randomUUID()));
      return results;
    });
    expect(rejected.every((r) => !r.ok)).toBe(true);
    const foreign = await app.evaluate(
      async ({ BrowserWindow }, preload) => {
        const owning = BrowserWindow.getAllWindows()[0];
        const w = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await w.loadURL(owning.webContents.getURL());
          return await w.webContents.executeJavaScript(
            'window.moonbaseChat.call("connection","getConnection",{},crypto.randomUUID())',
          );
        } finally {
          w.destroy();
        }
      },
      resolve(
        packaged
          ? `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/Resources/app.asar/preload.cjs`
          : 'dist/preload.cjs',
      ),
    );
    expect(foreign).toMatchObject({ ok: false, error: { code: 'Unauthorized' } });
    expect((await f.stats()).commands).toEqual(baseline.commands);
    expect(errors).toEqual([]);
    await stop(app);
    current = undefined;
  } finally {
    if (current) await stop(current, true);
    await close(f);
  }
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  test(`${packaged ? 'packaged' : 'source'} ${operation}: committed reply lost on Disconnect retains original identity and never resends`, async () => {
    await mkdir(output, { recursive: true });
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    try {
      const { app, page } = await launch(f, 'generation-data');
      current = app;
      await connect(page);
      await expect(page.getByText('Verified host.', { exact: false })).toBeVisible();
      if (operation !== 'createChat') {
        await createRemoteChat(page, 'Exact generation');
        await expect(
          page.getByRole('heading', { name: 'Exact generation', exact: true }),
        ).toBeVisible();
      }
      if (operation === 'stopChat') {
        await page
          .getByLabel('Message', { exact: true })
          .fill('One admitted task before exact Stop');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(page.getByRole('article', { name: 'Live response' })).toContainText(
          'Controlled remote tool activity',
        );
      }
      await f.holdReply(operation);
      if (operation === 'createChat') {
        await page.getByLabel('Message', { exact: true }).fill('Captured creation');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
      } else if (operation === 'sendChat') {
        await page
          .getByLabel('Message', { exact: true })
          .fill('Captured text at original generation');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
      } else await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await until(f.stats, (s) => s.heldReplies.includes(operation));
      const retained = await page.evaluate(
        (op) =>
          JSON.parse(localStorage.getItem('moonbase.chat.v1')!).pending.find(
            (p: { operation: string }) => p.operation === op,
          ),
        operation,
      );
      expect(retained.operation).toBe(operation);
      const originalConnection = await page.evaluate(
        async () =>
          await window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
      );
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await selectRemoteChat(page);
      await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
      await expect(page.getByRole('region', { name: 'Retained commands' })).toContainText(
        'Uncertain',
      );
      const afterLoss = await page.evaluate(
        (op) =>
          JSON.parse(localStorage.getItem('moonbase.chat.v1')!).pending.find(
            (p: { operation: string }) => p.operation === op,
          ),
        operation,
      );
      expect(afterLoss.input).toEqual(retained.input);
      if (operation === 'sendChat')
        await page
          .getByLabel('Message', { exact: true })
          .fill('Newer unsent edit after disconnect');
      await f.releaseReply();
      await expect.poll(() => reloadOutcome(app)).toBe('reload');
      await connect(page);
      await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
      if (operation !== 'createChat')
        await expect(page.getByRole('main').getByText(f.cwd, { exact: false })).toBeVisible();
      if (operation === 'sendChat') {
        await expect(page.getByRole('region', { name: 'Retained commands' })).toHaveCount(0);
        await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
          'Newer unsent edit after disconnect',
        );
      } else {
        const region = page.getByRole('region', { name: 'Retained commands' });
        await region.locator('summary').click();
        await region
          .getByRole('button', {
            name: operation === 'createChat' ? 'Retry original Create' : 'Retry original Stop',
            exact: true,
          })
          .click();
        await expect(region).toHaveCount(0);
      }
      const stats = await f.stats(),
        mutations = stats.mutations.filter((m) => m.operation === operation);
      expect(mutations.length).toBe(operation === 'sendChat' ? 1 : 2);
      for (const call of mutations) expect(call.input).toEqual(retained.input);
      if (operation === 'createChat') {
        expect(mutations[1].result).toEqual(mutations[0].result);
        expect(stats.calls).toBe(1);
      } else {
        expect(stats.commands.filter((c) => c === 'sendChat')).toHaveLength(1);
        expect(stats.tools).toBe(1);
      }
      const latestConnection = await page.evaluate(
        async () =>
          await window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
      );
      expect(latestConnection.ok && originalConnection.ok && latestConnection.value).not.toEqual(
        originalConnection.ok && originalConnection.value,
      );
      await writeFile(
        join(output, `${packaged ? 'packaged' : 'source'}-${operation}-generation.json`),
        JSON.stringify(
          {
            operation,
            retainedInput: retained.input,
            lossMessage: afterLoss.message,
            mutationInputs: mutations.map((m) => m.input),
            matchingReceipt:
              operation === 'createChat'
                ? JSON.stringify(mutations[0].result) === JSON.stringify(mutations[1].result)
                : undefined,
            sendDispatches: stats.commands.filter((c) => c === 'sendChat').length,
            tools: stats.tools,
          },
          null,
          2,
        ),
      );
      await stop(app);
      current = undefined;
    } finally {
      try {
        if (current) await stop(current, true);
      } finally {
        await close(f);
      }
    }
  });

test(`${packaged ? 'packaged' : 'source'} new-chat draft survives reload and refresh before the first Send`, async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    const { app, page } = await launch(f, 'create-readiness');
    current = app;
    await connect(page);
    for (let i = 0; i < 12; i++) {
      const message = 'Preserved first message ' + i;
      await page.getByLabel('Message', { exact: true }).fill(message);
      await page.getByRole('button', { name: 'Refresh saved chats', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      await expect.poll(() => reloadOutcome(app)).toBe('reload');
      await tab(page, 'Agents').click();
      await selectRemoteChat(page);
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue(message);
    }
    expect(
      (await f.stats()).commands.filter((operation) =>
        ['createChat', 'sendChat'].includes(operation),
      ),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Preserved first message 11', exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await f.stats()).commands.filter((operation) => operation === 'sendChat').length,
      )
      .toBe(1);
    expect(
      (await f.stats()).commands.filter((operation) => operation === 'createChat'),
    ).toHaveLength(1);
    await stop(app);
    current = undefined;
  } finally {
    if (current) await stop(current, true);
    await close(f);
  }
});

for (const failsWrite of [false, true])
  test(`R1 ${packaged ? 'packaged' : 'source'} reserved Send retry must veto ${failsWrite ? 'failing writes during query' : 'a changed snapshot'} before production admission`, async () => {
    await mkdir(output, { recursive: true });
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    try {
      const { app, page } = await launch(f, 'retry-preservation');
      current = app;
      await connect(page);
      await expect(page.getByText('Verified host.', { exact: false })).toBeVisible();
      await createRemoteChat(page, 'Retry preservation');
      await expect(
        page.getByRole('heading', { name: 'Retry preservation', exact: true }),
      ).toBeVisible();
      await page
        .getByLabel('Message', { exact: true })
        .fill('First admitted input keeps chat busy');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('article', { name: 'Live response' })).toContainText(
        'Controlled remote tool activity',
      );
      await page.getByLabel('Message', { exact: true }).fill('Captured second busy intent');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const region = page.getByRole('region', { name: 'Retained commands' });
      await expect(region).toContainText('Conflict');
      const pending = await page.evaluate(
        () => JSON.parse(localStorage.getItem('moonbase.chat.v1')!).pending[0],
      );
      await page.getByLabel('Message', { exact: true }).fill('Newer live draft remains');
      f.release();
      await expect(page.getByRole('article', { name: 'Live response' })).toHaveCount(0);
      const reserved = await page.evaluate(
        (p) =>
          window.moonbaseChat.call(
            'chat',
            'getChatSend',
            { target: p.input.target, requestId: p.input.requestId },
            crypto.randomUUID(),
          ),
        pending,
      );
      expect(reserved.ok && (reserved.value as { admission: string }).admission).toBe('reserved');
      const replacement = failsWrite
        ? await page.evaluate(() => localStorage.getItem('moonbase.chat.v1'))
        : await page.evaluate(() => {
            const key = 'moonbase.chat.v1',
              v = JSON.parse(localStorage.getItem(key)!);
            v.pending = [];
            v.drafts = [{ target: v.selected, text: 'Newer external publication' }];
            const raw = JSON.stringify(v);
            localStorage.setItem(key, raw);
            return raw;
          });
      if (failsWrite) await f.holdReply('getChatSend');
      const before = await f.stats();
      await region.locator('summary').click();
      await region.getByRole('button', { name: 'Retry original Send', exact: true }).click();
      if (failsWrite) {
        await until(f.stats, (s) => s.heldReplies.includes('getChatSend'));
        await page.evaluate(() => {
          Storage.prototype.setItem = function () {
            throw new DOMException('Controlled full storage', 'QuotaExceededError');
          };
        });
        await f.releaseReply();
      }
      await expect(page.getByRole('alert').first()).toContainText('preservation failed');
      await region.getByRole('button', { name: 'Query outcome', exact: true }).click();
      const after = await f.stats(),
        stored = await page.evaluate(() => localStorage.getItem('moonbase.chat.v1')),
        receipt = await page.evaluate(
          (p) =>
            window.moonbaseChat.call(
              'chat',
              'getChatSend',
              { target: p.input.target, requestId: p.input.requestId },
              crypto.randomUUID(),
            ),
          pending,
        );
      await page.screenshot({
        path: join(
          output,
          `r1-${packaged ? 'packaged' : 'source'}-retry-veto-${failsWrite ? 'write-fails' : 'changed'}.png`,
        ),
      });
      await writeFile(
        join(
          output,
          `r1-${packaged ? 'packaged' : 'source'}-retry-veto-${failsWrite ? 'write-fails' : 'changed'}.json`,
        ),
        JSON.stringify({ pending, reserved, receipt, before, after, replacement, stored }, null, 2),
      );
      expect(stored).toBe(replacement);
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
        'Newer live draft remains',
      );
      expect(after.commands.filter((c) => c === 'sendChat').length).toBe(
        before.commands.filter((c) => c === 'sendChat').length,
      );
      expect(receipt.ok && (receipt.value as { admission: string }).admission).toBe('reserved');
    } finally {
      try {
        if (current) await stop(current, true);
      } finally {
        await close(f);
      }
    }
  });

test('closing Chat removes its panel, preserves drafts and permits explicit reopen after cleanup', async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await setup(f);
    const { app, page: p } = await launch(f, 'panel-close');
    current = app;
    await connect(p);
    await create(p, 'Close and recover');
    await p.getByLabel('Message', { exact: true }).fill('preserved before panel close');
    await p.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await expect(tab(p, 'Agents')).toBeHidden();
    await expect(p.getByLabel('Message', { exact: true })).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Open checkout', exact: true })).toBeEnabled();
    await expect(p.getByRole('button', { name: 'Open Chat panel', exact: true })).toBeEnabled();
    await p.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue(
      'preserved before panel close',
    );
    expect((await f.stats()).commands.filter((command) => command === 'sendChat')).toHaveLength(0);
    await screen(app, p, 'reopened-panel');
  } finally {
    if (current) await stop(current, true);
    await f.close();
  }
});

if (!packaged) {
  test('removed Chat retains its cleanup lease and reports a failed cancellation acknowledgment outside the panel', async () => {
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    const nativeReport = join(f.directory, 'cleanup-error.json');
    try {
      await setup(f);
      const { app, page: p } = await launch(f, 'panel-error');
      current = app;
      await connect(p);
      await create(p, 'Closing with pending cleanup');
      await p.getByLabel('Message', { exact: true }).fill('preserved while cleanup fails');
      const preserved = await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'));
      await app.evaluate(() => {
        globalThis.desktopTest.holdChatCancel = true;
        globalThis.desktopTest.failChatCancel = true;
      });
      await p.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
      await expect.poll(() => app.evaluate(() => globalThis.desktopTest.chatCancelHeld)).toBe(true);
      await expect(tab(p, 'Agents')).toBeHidden();
      await expect(p.getByLabel('Message', { exact: true })).toHaveCount(0);
      await expect(p.getByRole('button', { name: 'Open Chat panel', exact: true })).toBeDisabled();
      await local(p, app, f);
      await editor(p).press('Meta+s');
      await expect.poll(async () => (await recovery(p)).state.drafts.length).toBe(0);
      await app.evaluate(() => globalThis.desktopTest.releaseChatCancel());
      await expect(p.getByRole('alert', { name: 'Panel cleanup errors' })).toContainText(
        'Controlled cancellation acknowledgment failure',
      );
      await expect(p.getByRole('button', { name: 'Open Chat panel', exact: true })).toBeDisabled();
      expect(await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'))).toBe(preserved);
      await screen(app, p, 'panel-cleanup-error');
      await app.evaluate(({ dialog }, report) => {
        dialog.showMessageBox = (async (_window, options) => {
          process.getBuiltinModule('fs').writeFileSync(report, JSON.stringify(options));
          return { response: 0, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      }, nativeReport);
      const child = app.process();
      await app.evaluate(({ app }) => app.quit());
      await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
      expect(child.exitCode).toBe(1);
      expect(await readFile(nativeReport, 'utf8')).toContain('Moonbase could not finish cleanup');
    } finally {
      if (current) await stop(current, true);
      await f.close();
    }
  });

  test('Quit waits for a removed panel cancellation acknowledgment before disposing the shared root', async () => {
    const f = await fixture(true);
    let current: ElectronApplication | undefined;
    try {
      const { app, page: p } = await launch(f, 'panel-quit');
      current = app;
      await connect(p);
      await app.evaluate(() => {
        globalThis.desktopTest.holdChatCancel = true;
      });
      await p.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
      await expect.poll(() => app.evaluate(() => globalThis.desktopTest.chatCancelHeld)).toBe(true);
      const child = app.process();
      await app.evaluate(({ app }) => app.quit());
      await expect(p.getByRole('status').filter({ hasText: 'Closing workbench' })).toBeVisible();
      expect(child.exitCode).toBeNull();
      await app.evaluate(() => globalThis.desktopTest.releaseChatCancel());
      await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
      expect(child.exitCode).toBe(0);
    } finally {
      if (current) await stop(current, true);
      await f.close();
    }
  });
}

if (!packaged) {
  for (const failure of ['editor', 'chat-context'] as const)
    test(`application ${failure} startup failure stays visible and native Quit remains responsive`, async () => {
      const f = await fixture(true);
      let current: ElectronApplication | undefined;
      try {
        await setup(f);
        const { app, page: p, errors } = await launch(f, 'startup-' + failure, failure);
        current = app;
        await screen(app, p, 'startup-' + failure);
        if (failure === 'chat-context') {
          await expect(p.getByLabel('Chat configuration')).toContainText(
            'Application effect failed',
          );
          await local(p, app, f);
          await expect(p.getByRole('alert', { name: 'Chat initialization failed' })).toBeVisible();
          await editor(p).press('Meta+s');
          await expect.poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('local dirty draft');
          await tab(p, 'Agents').click();
          await expect(p.getByLabel('Chat configuration')).toContainText(
            'Application effect failed',
          );
          expect(await reloadOutcome(app)).toBe('veto');
          await app.evaluate(({ app }) => app.quit());
          await expect(p.getByLabel('Chat configuration')).toBeVisible();
          expect(app.process().exitCode).toBeNull();
          await app.evaluate(() => {
            globalThis.desktopTest.startupFailure = null;
          });
          await p.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
          await selectRemoteChat(p);
          await expect(p.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
          expect((await f.stats()).calls).toBe(0);
          expect(errors).toEqual([]);
          await stop(app);
        } else {
          const alert = p.getByRole('alert', { name: 'Workbench startup failed' });
          await expect(alert).toContainText('Controlled editor recovery initialization failure');
          await expect(p.getByRole('button', { name: 'Open checkout', exact: true })).toHaveCount(
            0,
          );
          const report = join(f.directory, 'startup-error.json');
          await app.evaluate(({ dialog }, report) => {
            dialog.showMessageBox = (async (_window, options) => {
              process.getBuiltinModule('fs').writeFileSync(report, JSON.stringify(options));
              return { response: 0, checkboxChecked: false };
            }) as typeof dialog.showMessageBox;
          }, report);
          const child = app.process();
          await app.evaluate(({ app }) => app.quit());
          await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
          expect(child.exitCode).toBe(1);
          expect(await readFile(report, 'utf8')).toContain(
            'Controlled editor recovery initialization failure',
          );
          expect((await f.stats()).calls).toBe(0);
          expect(errors).toEqual([]);
        }
      } finally {
        if (current) await stop(current, true);
        await close(f);
      }
    });

  for (const handoff of ['dispose', 'reload'] as const)
    test(`prepared application fences native and synthetic actions until ${handoff} handoff completes`, async () => {
      const f = await fixture(true);
      let current: ElectronApplication | undefined;
      try {
        await setup(f);
        const { app, page: p, errors } = await launch(f, 'handoff-' + handoff);
        current = app;
        await local(p, app, f);
        await editor(p).press('Meta+s');
        await expect.poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('local dirty draft');
        await connect(p);
        await create(p, 'Consent handoff');
        await p.getByLabel('Message', { exact: true }).fill('preserved consent draft');
        const before = await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'));
        const report = join(f.directory, 'handoff.json');
        await app.evaluate(({ app, BrowserWindow, dialog }, report) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const send = contents.send.bind(contents);
          globalThis.applicationHandoff = {
            actions: [],
            pickers: 0,
            release: null,
            held: false,
            quitId: null,
            obsoleteAcknowledgments: 0,
          };
          dialog.showOpenDialog = (async () => {
            globalThis.applicationHandoff.pickers++;
            return { canceled: true, filePaths: [] };
          }) as typeof dialog.showOpenDialog;
          contents.send = ((channel, ...args) => {
            if (channel === 'moonbase:action') {
              globalThis.applicationHandoff.actions.push(args[0]);
              if (args[0] === 'quit') {
                const previousId = globalThis.applicationHandoff.quitId;
                globalThis.applicationHandoff.quitId = args[1];
                if (previousId) {
                  void contents
                    .executeJavaScript(
                      `window.moonbase.quitResult(${JSON.stringify(previousId)}, false)`,
                    )
                    .then(() => {
                      globalThis.applicationHandoff.obsoleteAcknowledgments++;
                      send(channel, ...args);
                    });
                  return;
                }
              }
              if (args[0] === 'dispose' && !globalThis.applicationHandoff.held) {
                globalThis.applicationHandoff.held = true;
                globalThis.applicationHandoff.release = () => send(channel, ...args);
                return;
              }
            }
            send(channel, ...args);
          }) as typeof contents.send;
          app.once('will-quit', () => {
            process
              .getBuiltinModule('fs')
              .writeFileSync(report, JSON.stringify(globalThis.applicationHandoff));
          });
        }, report);
        const child = app.process();
        await app.evaluate(({ app }) => app.quit());
        await expect.poll(() => app.evaluate(() => globalThis.applicationHandoff.held)).toBe(true);
        await expect(p.getByRole('status').filter({ hasText: 'Closing workbench' })).toBeVisible();
        await app.evaluate(({ app }) => app.quit());
        await p.evaluate(() => {
          document.querySelector('[aria-label="Moonbase workbench"]')?.removeAttribute('inert');
          const message = document.querySelector<HTMLTextAreaElement>('#message')!;
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
            message,
            'rejected after consent',
          );
          message.dispatchEvent(new Event('input', { bubbles: true }));
          message
            .closest('form')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          for (const name of ['Open checkout', 'Close Chat panel'])
            [...document.querySelectorAll<HTMLButtonElement>('button')]
              .find((button) => button.getAttribute('aria-label') === name)
              ?.click();
        });
        expect(await p.evaluate(() => localStorage.getItem('moonbase.chat.v1'))).toBe(before);
        expect(await app.evaluate(() => globalThis.applicationHandoff.pickers)).toBe(0);
        expect(
          (await f.stats()).commands.filter((name) => ['sendChat', 'stopChat'].includes(name)),
        ).toEqual([]);
        if (handoff === 'reload') expect(await reloadOutcome(app)).toBe('reload');
        else await app.evaluate(() => globalThis.applicationHandoff.release?.());
        await until(async () => child.exitCode !== null || child.signalCode !== null, Boolean);
        expect(child.exitCode).toBe(0);
        const result = JSON.parse(await readFile(report, 'utf8')) as {
          actions: string[];
          obsoleteAcknowledgments: number;
        };
        expect(result.actions.filter((action) => action === 'quit')).toHaveLength(
          handoff === 'reload' ? 2 : 1,
        );
        expect(result.actions.filter((action) => action === 'dispose')).toHaveLength(
          handoff === 'reload' ? 2 : 1,
        );
        expect(result.obsoleteAcknowledgments).toBe(handoff === 'reload' ? 1 : 0);
        expect(errors).toEqual([]);
      } finally {
        if (current) await stop(current, true);
        await close(f);
      }
    });
}

declare global {
  var applicationHandoff: {
    actions: string[];
    pickers: number;
    release: (() => void) | null;
    held: boolean;
    quitId: string | null;
    obsoleteAcknowledgments: number;
  };
}
