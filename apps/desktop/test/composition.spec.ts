import { captureNative } from './editor-regressions.ts';
import type { CheckoutTarget } from '@moonbase/application/client';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { fixture, until } from '@moonbase/chat-probe/test-fixture';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const children = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>();
const output = resolve(process.env.MOONBASE_NATIVE_OUTPUT ?? 'test-results', 'composition');
async function launch(f: Fixture, data = 'desktop-data') {
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
    await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
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
  await tab(p, 'Chat').click();
  await p.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(p.getByLabel('New saved chat')).toBeEnabled();
}
async function create(p: Page, title: string) {
  await p.getByLabel('New saved chat').fill(title);
  await p.getByRole('button', { name: 'Create chat', exact: true }).click();
  await expect(p.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(p.getByLabel('Message', { exact: true })).toBeEnabled();
}
async function saved(p: Page) {
  return p.evaluate(() => JSON.parse(localStorage.getItem('moonbase.chat-proof.v1')!));
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
    await tab(p, 'Chat').focus();
    await p.keyboard.press('ArrowLeft');
    await expect(tab(p, 'Editor')).toBeFocused();
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
    await expect(tab(p, 'Editor')).toBeFocused();
    await expect(tab(p, 'Editor')).toHaveAttribute('aria-selected', 'true');
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
    await tab(p, 'Chat').click();
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
          const outcome = await app.evaluate(
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
          reloadOutcomes.push(outcome);
          return outcome;
        })
        .toBe('reload');
    } finally {
      await writeFile(join(output, 'durable-reload-outcomes.json'), JSON.stringify(reloadOutcomes));
    }
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
    await tab(p, 'Chat').click();
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
    await tab(p, 'Editor').click();
    await expect(editor(p)).toBeFocused();
    await p.getByRole('button', { name: 'Close a.ts', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8'))
      .toBe('local dirty draft + live tool editing');
    await p.getByRole('button', { name: 'Close a.ts', exact: true }).click();
    await expect(editor(p)).toHaveCount(0);
    expect((await f.stats()).commands.filter((v) => v === 'stopChat')).toHaveLength(0);
    await tab(p, 'Chat').click();
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
      const prior = await p.evaluate(() => localStorage.getItem('moonbase.chat-proof.v1'));
      await p.evaluate((change) => {
        if (change === 'external') localStorage.setItem('moonbase.chat-proof.v1', 'external bytes');
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
      await tab(p, 'Editor').click();
      await expect(editor(p)).toBeVisible();
      await expect(
        p.locator('.view-line').filter({ hasText: 'local dirty draft' }).first(),
      ).toBeVisible();
      await expect
        .poll(async () => (await recovery(p)).state.drafts[0]?.text)
        .toBe('local dirty draft');
      const bytes = await p.evaluate(() => localStorage.getItem('moonbase.chat-proof.v1'));
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
      await expect.poll(() => main.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
      await p.getByLabel('Message', { exact: true }).focus();
      await p.keyboard.press('Tab');
      await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeFocused();
      await expect(p.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
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
    await tab(p, 'Editor').click();
    await expect(editor(p)).toBeFocused();
    await editor(p).press('End');
    await editor(p).pressSequentially(' after zoom');
    await p.getByRole('button', { name: 'Save', exact: true }).click();
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
    await tab(p, 'Editor').click();
    await writeFile(join(f.cwd, 'a.ts'), 'external conflicting change');
    await app.evaluate(({ app }) => app.quit());
    await p.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      p.getByRole('button', { name: 'Overwrite observed version', exact: true }),
    ).toBeVisible();
    await p.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(children.get(app)!.exitCode).toBeNull();
    await expect(editor(p)).toBeVisible();
    await tab(p, 'Chat').click();
    await p.getByLabel('Message', { exact: true }).fill('newer draft after cancelled Quit');
    await tab(p, 'Editor').click();
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
      await tab(p, 'Editor').click();
      await app.evaluate(() => {
        globalThis.desktopTest.held = 'saveFile';
      });
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => app.evaluate(() => globalThis.desktopTest.held)).toBe('waiting');
      await tab(p, 'Chat').click();
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
      await tab(p, 'Editor').click();
      await expect(p.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
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
      await tab(p, 'Chat').click();
      await p
        .getByLabel('Message', { exact: true })
        .fill('latest chat while editor publication unknown');
      await tab(p, 'Editor').click();
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
    await tab(p, 'Editor').click();
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => readFile(join(f.cwd, 'a.ts'), 'utf8')).toBe('local dirty draft');
    expect((await recovery(p)).state.checkouts).toHaveLength(1);
    await tab(p, 'Chat').click();
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
