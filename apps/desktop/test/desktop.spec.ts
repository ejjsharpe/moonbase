import {
  openTabMenu,
  saveFile,
  selectFileView,
  captureNative,
  pasteNativeFile,
  filenameCases,
  checkFilenameMaps,
  checkTabMenu,
} from './editor-regressions.ts';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

let app: ElectronApplication, child: ChildProcess, page: Page, base: string, checkout: string;
const errors: string[] = [],
  consoleErrors: string[] = [];
declare global {
  interface Window {
    firstOpenTiming: { started: number; visible: number };
  }
  var desktopTest: {
    startupFailure: string | null;
    chatCalls: { kind: string; id: string }[];
    cancelIds: string[];
    chatCancelIds: string[];
    calls: {
      id: string;
      method: string;
      input: { operation?: string; input?: Record<string, unknown> };
    }[];
    results: {
      operation?: string;
      reply: { ok: boolean; value?: { items: { message?: string }[] } };
    }[];
    fault: string | null;
    noStatus: boolean;
    outage: string | null;
    restoreOn: string | null;
    held: string | null;
    release(): void;
    cancels: number;
    holdChatCancel: boolean;
    chatCancelHeld: boolean;
    failChatCancel: boolean;
    releaseChatCancel(): void;
  };
}
test.beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-desktop-')));
  checkout = join(base, 'checkout');
  mkdirSync(checkout);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        checkout,
        '-c',
        'user.name=Moonbase Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'a.ts'), "export const value = 'HEAD';\n");
  writeFileSync(join(checkout, 'b.ts'), 'export const b = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'Controlled fixture');
  writeFileSync(join(checkout, 'a.ts'), "export const value = 'INDEX';\n");
  git('add', 'a.ts');
  writeFileSync(join(checkout, 'a.ts'), "export const value = 'WORKING';\n");
  await launch();
});
async function launch() {
  errors.length = 0;
  consoleErrors.length = 0;
  const env = {
    ...process.env,
    MOONBASE_USER_DATA: join(base, 'user-data'),
    MOONBASE_TEST_REPORT: join(base, 'quit-report.json'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve('test/harness.mjs')], env, timeout: 20000 });
  child = app.process();
  child.stderr?.on('data', (value) => console.log(String(value)));
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (response) => {
    if (response.status() >= 400) console.log('Renderer HTTP:', response.status(), response.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      console.log('Renderer console:', message.text());
    }
  });
  await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [root],
    })) as typeof dialog.showOpenDialog;
  }, checkout);
}
// oxlint-disable-next-line no-empty-pattern -- Playwright requires a fixture pattern; this Electron hook must not allocate browser fixtures.
test.afterEach(async ({}, info) => {
  try {
    expect(errors).toEqual([]);
    expect(
      consoleErrors.filter(
        (text) => !(info.title.includes('actual IPC rejects') && text.includes('frame-src')),
      ),
    ).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await forceStop();
    rmSync(base, { recursive: true, force: true });
  }
});
async function capture(name: string) {
  await captureNative(app, page, test.info().outputPath(`${name}.png`));
}
async function forceStop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exit;
}
async function open(path = 'a.ts') {
  if (!(await page.getByRole('button', { name: 'Find file', exact: true }).count())) {
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'checkout · main', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('treeitem').first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Find file', exact: true }).click();
  await page.getByRole('combobox').fill(path);
  await expect(page.getByRole('option', { name: path, exact: true })).toBeVisible();
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByRole('textbox', { name: `${path} editor`, exact: true })).toBeVisible();
}
async function edit(text: string, path = 'a.ts') {
  const input = page.getByRole('textbox', { name: `${path} editor`, exact: true });
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially(text);
}
for (const holdDiscovery of [false, true])
  test(`rapid native Open to Find retains the dialog (${holdDiscovery ? 'held discovery' : 'immediate'})`, async () => {
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    await page.evaluate(() => {
      const events: unknown[] = [];
      let previous = '';
      Object.assign(window, { rapidLookupEvents: events });
      const record = () => {
        const active = document.activeElement,
          state = JSON.stringify({
            dialogs: document.querySelectorAll('[role="dialog"]').length,
            focus:
              active?.getAttribute('aria-label') ?? active?.getAttribute('role') ?? active?.tagName,
            selected: document.querySelector(
              '[aria-label="Workbench views"] [aria-selected="true"]',
            )?.textContent,
          });
        if (state !== previous) {
          previous = state;
          events.push({ time: performance.now(), state: JSON.parse(state) });
        }
      };
      new MutationObserver(record).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      });
      document.addEventListener('focusin', record);
      record();
    });
    try {
      if (holdDiscovery)
        await app.evaluate(() => {
          globalThis.desktopTest.held = 'listDirectory';
        });
      await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
      await page.getByRole('button', { name: 'Find file', exact: true }).click();
      await page.getByRole('combobox').fill('a.ts');
      if (holdDiscovery) {
        await expect.poll(() => app.evaluate(() => globalThis.desktopTest.held)).toBe('waiting');
        await app.evaluate(() => {
          globalThis.desktopTest.release();
        });
      }
      await expect(page.getByRole('option', { name: 'a.ts', exact: true })).toBeVisible();
      await page.getByRole('combobox').press('Enter');
      await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeFocused();
      await page
        .getByRole('textbox', { name: 'a.ts editor', exact: true })
        .pressSequentially('rapid flow typing');
      await expect(
        page.locator('.view-line').filter({ hasText: 'rapid flow typing' }).first(),
      ).toBeVisible();
    } finally {
      const evidence = {
        holdDiscovery,
        events: await page.evaluate(
          () => (window as unknown as { rapidLookupEvents: unknown[] }).rapidLookupEvents,
        ),
        io: await app.evaluate(() => ({
          calls: globalThis.desktopTest.calls,
          results: globalThis.desktopTest.results,
        })),
      };
      const eventsPath = test.info().outputPath('rapid-lookup-events.json');
      writeFileSync(eventsPath, JSON.stringify(evidence, null, 2) + '\n');
      await test
        .info()
        .attach('rapid-lookup-events', { path: eventsPath, contentType: 'application/json' });
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString('base64'),
      );
      const screenshotPath = test.info().outputPath('rapid-lookup-screen.png');
      writeFileSync(screenshotPath, Buffer.from(png, 'base64'));
      await test
        .info()
        .attach('rapid-lookup-screen', { path: screenshotPath, contentType: 'image/png' });
      await app.context().tracing.stop({ path: test.info().outputPath('rapid-lookup-trace.zip') });
    }
  });
test('first native folder open displays ignored files before Git classification finishes', async () => {
  mkdirSync(join(checkout, 'src'));
  writeFileSync(join(checkout, 'src/normal.ts'), 'normal');
  writeFileSync(join(checkout, 'src/ignored.ts'), 'ignored');
  writeFileSync(join(checkout, 'root-hidden.txt'), 'ignored root marker');
  writeFileSync(join(checkout, '.gitignore'), 'root-hidden.txt\nsrc/ignored.ts\n');
  await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(
    page.getByRole('treeitem', { name: 'root-hidden.txt', exact: true }),
  ).toHaveAttribute('aria-description', 'Git-ignored');
  const ignored = page.getByRole('treeitem', { name: 'src/ignored.ts', exact: true });
  await expect(ignored).toHaveCount(0);
  await app.evaluate(() => {
    globalThis.desktopTest.held = 'getIgnoredPaths';
  });
  await page.evaluate(() => {
    window.firstOpenTiming = { started: 0, visible: 0 };
    document.addEventListener(
      'click',
      function begin(event) {
        if (
          (event.target as Element).closest('[role="treeitem"]')?.getAttribute('aria-label') !==
          'src'
        )
          return;
        window.firstOpenTiming.started = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelector('[role="treeitem"][aria-label="src/ignored.ts"]')) {
            window.firstOpenTiming.visible = performance.now();
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.removeEventListener('click', begin, true);
      },
      true,
    );
  });
  try {
    await page.getByRole('treeitem', { name: 'src', exact: true }).click();
    await expect(ignored).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'src/normal.ts', exact: true })).toBeVisible();
    await expect.poll(() => app.evaluate(() => globalThis.desktopTest.held)).toBe('waiting');
    await expect(ignored).not.toHaveAttribute('aria-description');
    const milliseconds = await page.evaluate(
      () => window.firstOpenTiming.visible - window.firstOpenTiming.started,
    );
    console.log(
      `First native folder open, click to rows with Git held: ${milliseconds.toFixed(1)} ms`,
    );
    await test.info().attach('first-folder-open', {
      body: JSON.stringify({ clickToRowsMs: milliseconds, gitClassificationHeld: true }),
      contentType: 'application/json',
    });
    await app.evaluate(() => {
      globalThis.desktopTest.release();
    });
    await expect(ignored).toHaveAttribute('aria-description', 'Git-ignored');
    await expect(ignored.getByText('ignored.ts', { exact: true })).toHaveCSS(
      'color',
      'rgb(139, 144, 160)',
    );
    await capture('ignored-files-first-open');
  } finally {
    await app.evaluate(() => {
      globalThis.desktopTest.release();
    });
  }
});

test('actual sandboxed custom-scheme editor reads, edits and saves through SQLite workspace', async () => {
  await page
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .getByRole('tab', { name: 'Agents', exact: true })
    .click();
  await expect(page.getByText('Local ready', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.moonbaseChat.call('connection', 'getConnection', {}, crypto.randomUUID()),
    ),
  ).toMatchObject({ ok: false, error: { code: 'Unauthorized' } });
  await open();
  await edit('export const saved = 42;');
  await saveFile(page);
  await expect
    .poll(() => readFileSync(join(checkout, 'a.ts'), 'utf8'))
    .toBe('export const saved = 42;');
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require: unknown }).require,
      process: typeof (window as unknown as { process: unknown }).process,
      url: location.href,
    })),
  ).toEqual({ node: 'undefined', process: 'undefined', url: 'moonbase://editor/index.html' });
  await capture('desktop-normal');
  expect(errors).toEqual([]);
});

async function checkoutTarget() {
  await expect.poll(async () => (await recovery()).state.checkouts.length).toBeGreaterThan(0);
  return page.evaluate(async () => {
    const r = await window.moonbase.call(
      'command',
      { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
      crypto.randomUUID(),
    );
    if (!r.ok) throw Error(r.error.message);
    return (r.value as RecoveryLoad).state.checkouts[0];
  });
}
async function recovery() {
  return page.evaluate(async () => {
    const r = await window.moonbase.call(
      'command',
      { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
      crypto.randomUUID(),
    );
    if (!r.ok) throw Error(r.error.message);
    return r.value as RecoveryLoad;
  });
}
async function quit() {
  await app.evaluate(({ app }) => {
    app.quit();
  });
}

test('actual conflict Compare, Cancel, Overwrite and Reload retain one dirty working buffer and Git index', async () => {
  await open();
  await edit('my unsaved text');
  writeFileSync(join(checkout, 'a.ts'), 'external text');
  await saveFile(page);
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
  await expect(
    page.locator('.monaco-diff-editor .view-line').filter({ hasText: 'external text' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toBe('external text');
  await saveFile(page);
  await page.getByRole('button', { name: 'Overwrite observed version', exact: true }).click();
  await expect.poll(() => readFileSync(join(checkout, 'a.ts'), 'utf8')).toBe('my unsaved text');
  for (const area of ['staged', 'unstaged']) {
    await selectFileView(page, area);
    await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
    // Monaco's accessible label is exercised together with its readonly editor option by the module suite.
    await expect(page.getByRole('textbox', { name: / original$/, exact: false })).toHaveCount(1);
    await edit('shared ' + area);
    await selectFileView(page, 'file');
    await expect(
      page
        .locator('.view-line')
        .filter({ hasText: 'shared ' + area })
        .first(),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(
    page.locator('.view-line').filter({ hasText: 'shared unstaged' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(
    page.locator('.view-line').filter({ hasText: 'shared unstaged' }).first(),
  ).toBeVisible();
  writeFileSync(join(checkout, 'a.ts'), 'latest external');
  await saveFile(page);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(
    page.locator('.view-line').filter({ hasText: 'latest external' }).first(),
  ).toBeVisible();
  expect(
    execFileSync('/usr/bin/git', ['-C', checkout, 'show', ':a.ts'], { encoding: 'utf8' }),
  ).toContain('INDEX');
  expect(errors).toEqual([]);
});

test('window close hides mounted Monaco; Quit Cancel preserves undo, then Save quits and releases resources', async () => {
  await open();
  await edit('retained across hide');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  ).toBe(false);
  await app.evaluate(({ app }) => {
    app.emit('activate', {} as never, false);
  });
  const input = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
  await expect(input).toBeVisible();
  await input.focus();
  for (
    let step = 0;
    step < 8 && !(await page.locator('.view-line').filter({ hasText: 'WORKING' }).count());
    step++
  )
    await input.press('Meta+z');
  await expect(page.locator('.view-line').filter({ hasText: 'WORKING' }).first()).toBeVisible();
  for (
    let step = 0;
    step < 8 &&
    !(await page.locator('.view-line').filter({ hasText: 'retained across hide' }).count());
    step++
  )
    await input.press('Meta+Shift+z');
  await expect(
    page.locator('.view-line').filter({ hasText: 'retained across hide' }).first(),
  ).toBeVisible();
  await input.press('End');
  await input.pressSequentially(' extra');
  await input.press('Meta+z');
  await expect(
    page.locator('.view-line').filter({ hasText: 'retained across hide' }).first(),
  ).toBeVisible();
  await quit();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.focus();
  await input.press('End');
  await input.pressSequentially(' after cancel');
  await open('b.ts');
  await edit('second draft after cancel', 'b.ts');
  await quit();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('b.ts has unsaved changes');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toContain('after cancel');
  await expect(
    page.locator('.view-line').filter({ hasText: 'second draft after cancel' }).first(),
  ).toBeVisible();
  const exited = app.waitForEvent('close');
  await quit();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await exited;
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toContain('after cancel');
  expect(readFileSync(join(checkout, 'b.ts'), 'utf8')).toBe('second draft after cancel');
  const report = JSON.parse(readFileSync(join(base, 'quit-report.json'), 'utf8'));
  expect(report.resources.filter((name: string) => /FSWatcher/.test(name))).toEqual([]);
  expect(report.cancelListeners).toBe(0);
  expect(report.chatCancelListeners).toBe(0);
  const db = new DatabaseSync(join(base, 'user-data/workspace-v1/moonbase-workspace-v1.sqlite'));
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
  db.close();
});

test('SQLite contention vetoes Quit Discard; exact resolution and fresh choice keep window usable', async () => {
  await open();
  await edit('draft survives contention');
  await expect
    .poll(async () => (await recovery()).state.drafts[0]?.text)
    .toBe('draft survives contention');
  const db = new DatabaseSync(join(base, 'user-data/workspace-v1/moonbase-workspace-v1.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  try {
    await quit();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
    ).toBeVisible();
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  await page.getByRole('button', { name: 'Resolve recovery publication', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
  await input.focus();
  await input.press('End');
  await input.pressSequentially(' still editable');
  expect((await recovery()).state.drafts.length).toBeGreaterThan(0);
  const exited = app.waitForEvent('close');
  await quit();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await exited;
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toContain('WORKING');
});

test('dirty recovery and comparison metadata restore across actual process restart', async () => {
  await open();
  await selectFileView(page, 'staged');
  await expect(page.getByRole('textbox', { name: / original$/ })).toHaveCount(1);
  await edit('dirty restored staged');
  await expect
    .poll(async () => (await recovery()).state.drafts.find((d) => d.target.path === 'a.ts')?.text)
    .toBe('dirty restored staged');
  await forceStop();
  await launch();
  await page.getByRole('tab', { name: 'checkout · main', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'HEAD ↔ working buffer original', exact: true }),
  ).toBeVisible();
  const restored = (await recovery()).state;
  expect(restored.views[restored.selectedCheckoutId!].fileViews['a.ts']).toBe('staged');
  await expect(
    page.locator('.view-line').filter({ hasText: 'dirty restored staged' }).first(),
  ).toBeVisible();
  expect((await recovery()).state.drafts[0].disk.text).toContain('WORKING');
  await capture('desktop-restored-diff');
  expect(errors).toEqual([]);
});

test('lost real Save reply retries original identity without replacing the native file again', async () => {
  await open();
  await edit('captured Save');
  await expect.poll(async () => (await recovery()).state.drafts[0]?.text).toBe('captured Save');
  await app.evaluate(() => {
    globalThis.desktopTest.fault = 'saveFile';
  });
  await saveFile(page);
  await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toBeEnabled();
  await expect.poll(() => readFileSync(join(checkout, 'a.ts'), 'utf8')).toBe('captured Save');
  const savedInode = statSync(join(checkout, 'a.ts')).ino;
  await edit('newer after lost reply');
  await page.getByRole('button', { name: 'Retry Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await recovery()).state.drafts[0]?.text)
    .toBe('newer after lost reply');
  const saves = await app.evaluate(() =>
    globalThis.desktopTest.calls.filter((call) => call.input?.operation === 'saveFile'),
  );
  expect(saves).toHaveLength(2);
  expect(saves[0].input.input).toEqual(saves[1].input.input);
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toBe('captured Save');
  expect(statSync(join(checkout, 'a.ts')).ino).toBe(savedInode);
});

test('actual IPC rejects unapproved roots, foreign callers/targets, unknown inputs and navigation', async () => {
  const denied = await page.evaluate(
    async (root) =>
      window.moonbase.call(
        'command',
        { operation: 'openCheckout', input: { root } },
        crypto.randomUUID(),
      ),
    checkout,
  );
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error.code).toBe('Unauthorized');
  await open();
  const target = await checkoutTarget();
  for (const input of [
    { operation: '__proto__', input: {} },
    { operation: 'loadRecovery', input: { clientId: 'foreign' } },
    { operation: 'readFile', input: { checkout: { ...target, hostId: 'foreign' }, path: 'a.ts' } },
    { operation: 'readFile', input: { checkout: target, path: '../outside' } },
    { operation: 'readFile', input: { checkout: target, path: 'a.ts', ignored: true } },
  ]) {
    const r = await page.evaluate(
      (input) => window.moonbase.call('command', input, crypto.randomUUID()),
      input,
    );
    expect(r.ok).toBe(false);
  }
  const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await other.loadURL('moonbase://editor/index.html');
      return await other.webContents.executeJavaScript(
        'window.moonbase.call("command", {operation:"loadRecovery",input:{clientId:window.moonbase.clientId}}, "foreign-frame")',
      );
    } finally {
      other.destroy();
    }
  }, resolve('dist/preload.cjs'));
  expect(foreign.ok).toBe(false);
  expect(foreign.error.code).toBe('Unauthorized');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => {
    window.open('https://example.invalid/');
  });
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
    windows,
  );
  await page.evaluate(() => {
    location.href = 'https://example.invalid/';
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()),
    )
    .toBe('moonbase://editor/index.html');
  expect(await page.evaluate(() => location.href)).toBe('moonbase://editor/index.html');
  const localFrame = await page.evaluate(async () => {
    const frame = document.createElement('iframe'),
      loaded = new Promise<void>((resolve) => (frame.onload = () => resolve()));
    frame.srcdoc = '<p>Local frame</p>';
    document.body.append(frame);
    await loaded;
    return typeof (frame.contentWindow as (Window & { moonbase?: unknown }) | null)?.moonbase;
  });
  expect(localFrame).toBe('undefined');
  const framePolicy = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) =>
      document.addEventListener(
        'securitypolicyviolation',
        (event) => resolve(event.effectiveDirective),
        { once: true },
      ),
    );
    const frame = document.createElement('iframe');
    frame.src = 'moonbase://editor/index.html';
    document.body.append(frame);
    return violation;
  });
  expect(framePolicy).toBe('frame-src');
  const wrongDocument = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    await window.loadURL('about:blank');
    return window.webContents.executeJavaScript(
      'window.moonbase.call("command", {operation:"loadRecovery", input:{clientId:window.moonbase.clientId}}, "wrong-document")',
    );
  });
  expect(wrongDocument.ok).toBe(false);
  expect(wrongDocument.error.code).toBe('Unauthorized');
});

test('native picker creates scoped single-use tokens through the actual bridge; fake File paths grant no authority', async () => {
  await open();
  const approved = await checkoutTarget(),
    source = join(base, 'native-import.txt');
  writeFileSync(source, 'CONTROLLED NATIVE IMPORT');
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [source],
    })) as typeof dialog.showOpenDialog;
  }, source);
  const refs = await page.evaluate(async (checkout) => {
    const result = await window.moonbase.call('choose-imports', { checkout }, crypto.randomUUID());
    if (!result.ok) throw Error(result.error.message);
    return result.value as string[];
  }, approved);
  expect(refs).toHaveLength(1);
  expect(refs[0]).not.toContain(source);
  const result = await page.evaluate(
    async ({ checkout, refs }) =>
      window.moonbase.call(
        'command',
        {
          operation: 'mutate',
          input: {
            id: crypto.randomUUID(),
            clientId: window.moonbase.clientId,
            checkout,
            kind: 'import',
            sources: [],
            destination: 'imported.txt',
            nativeReferences: refs,
          },
        },
        crypto.randomUUID(),
      ),
    { checkout: approved, refs },
  );
  expect(result.ok).toBe(true);
  expect(readFileSync(join(checkout, 'imported.txt'), 'utf8')).toBe('CONTROLLED NATIVE IMPORT');
  const reused = await page.evaluate(
    async ({ checkout, refs }) =>
      window.moonbase.call(
        'command',
        {
          operation: 'mutate',
          input: {
            id: crypto.randomUUID(),
            clientId: window.moonbase.clientId,
            checkout,
            kind: 'import',
            sources: [],
            destination: 'reused.txt',
            nativeReferences: refs,
          },
        },
        crypto.randomUUID(),
      ),
    { checkout: approved, refs },
  );
  expect(reused.ok).toBe(false);
  if (!reused.ok) expect(reused.error.code).toBe('Unauthorized');
  expect(existsSync(join(checkout, 'reused.txt'))).toBe(false);
  const fakeDrop = await page.evaluate(async (checkout) => {
    try {
      return await window.moonbase.drop(checkout, [new File(['fake'], 'outside.txt')]);
    } catch {
      return { ok: false };
    }
  }, approved);
  expect(fakeDrop.ok).toBe(false);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'native-fixture';
    document.body.append(input);
  });
  await page.locator('#native-fixture').setInputFiles(source);
  const dropped = await page.evaluate(
    async (checkout) =>
      window.moonbase.drop(checkout, [
        ...document.querySelector<HTMLInputElement>('#native-fixture')!.files!,
      ]),
    approved,
  );
  expect(dropped.ok).toBe(true);
  if (!dropped.ok) throw Error(dropped.error.message);
  const copied = await page.evaluate(
    async ({ checkout, refs }) =>
      window.moonbase.call(
        'command',
        {
          operation: 'mutate',
          input: {
            id: crypto.randomUUID(),
            clientId: window.moonbase.clientId,
            checkout,
            kind: 'import',
            sources: [],
            destination: 'dropped.txt',
            nativeReferences: refs,
          },
        },
        crypto.randomUUID(),
      ),
    { checkout: approved, refs: dropped.value },
  );
  expect(copied.ok).toBe(true);
  expect(readFileSync(join(checkout, 'dropped.txt'), 'utf8')).toBe('CONTROLLED NATIVE IMPORT');
});

test("controlled clipboard fixtures require native consent and capture real files without accessing user's clipboard", async () => {
  await open();
  const approved = await checkoutTarget(),
    source = join(base, 'clipboard-import.txt');
  writeFileSync(source, 'CONTROLLED CLIPBOARD IMPORT');
  await app.evaluate(({ clipboard, dialog }, _source) => {
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
    clipboard.read = async () => {
      throw Error('Clipboard must not be read after Cancel');
    };
  }, source);
  const refs = await page.evaluate(
    async (checkout) =>
      window.moonbase.call('clipboard-imports', { checkout }, crypto.randomUUID()),
    approved,
  );
  expect(refs).toEqual({ ok: true, value: [] });
  await app.evaluate(({ clipboard, dialog, ClipboardItem }, source) => {
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${source}</string></array></plist>`;
    clipboard.read = async () => [
      new ClipboardItem({
        'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([xml]),
      }),
    ];
  }, source);
  await page.getByRole('tree', { name: 'Files', exact: true }).focus();
  expect(
    await page.getByRole('tree', { name: 'Files', exact: true }).evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
  ).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Import files', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Destination relative path').fill('clipboard.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Import files', exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, 'clipboard.txt'))).toBe(true);
  expect(readFileSync(join(checkout, 'clipboard.txt'), 'utf8')).toBe('CONTROLLED CLIPBOARD IMPORT');
});

test('real create, dirty move and copy use native operations; lost move reply resolves status without replay', async () => {
  await open();
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByLabel('Destination relative path').fill('created.ts');
  await page.getByRole('dialog').getByRole('button', { name: 'New File', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'created.ts', exact: true })).toBeVisible();
  await edit('dirty created buffer', 'created.ts');
  await page.getByRole('treeitem', { name: 'created.ts, unsaved', exact: true }).click();
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Destination relative path').fill('renamed.ts');
  // Keep live observation from resolving the fact before the explicit status gesture.
  await app.evaluate(() => {
    globalThis.desktopTest.fault = 'mutate';
    globalThis.desktopTest.outage = 'loadRecovery';
    globalThis.desktopTest.restoreOn = 'operationStatus';
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, 'renamed.ts'))).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve operation status', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'renamed.ts', exact: true })).toBeVisible();
  await expect(
    page.locator('.view-line').filter({ hasText: 'dirty created buffer' }).first(),
  ).toBeVisible();
  await page.getByRole('treeitem', { name: 'renamed.ts, unsaved', exact: true }).click();
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await page.getByLabel('Destination relative path').fill('copied.ts');
  await page.getByRole('dialog').getByRole('button', { name: 'Copy', exact: true }).click();
  await open('copied.ts');
  await expect(
    page.locator('.view-line').filter({ hasText: 'dirty created buffer' }).first(),
  ).toBeVisible();
  await edit('saved only copied buffer', 'copied.ts');
  await saveFile(page);
  await expect
    .poll(() => readFileSync(join(checkout, 'copied.ts'), 'utf8'))
    .toBe('saved only copied buffer');
  expect(readFileSync(join(checkout, 'renamed.ts'), 'utf8')).toBe('');
  const calls = await app.evaluate(() =>
    globalThis.desktopTest.calls.filter((call) => call.input?.operation === 'mutate'),
  );
  expect(calls).toHaveLength(3);
  expect(existsSync(join(checkout, 'created.ts'))).toBe(false);
  expect(errors).toEqual([]);
});

test('previews, Keep Open, order, keyboard Close/Reopen and overflow remain useful at small size and zoom', async () => {
  for (let i = 0; i < 10; i++)
    writeFileSync(
      join(checkout, `long-component-name-for-overflow-${i}.ts`),
      `export const item${i} = ${i};\n`,
    );
  await open();
  await page.getByRole('treeitem', { name: 'b.ts', exact: true }).click();
  const preview = page.getByRole('tab', { name: 'b.ts', exact: true });
  await expect(preview).toHaveAttribute('aria-description', 'Preview');
  await preview.dblclick();
  await expect(preview).not.toHaveAttribute('aria-description', 'Preview');
  for (let i = 0; i < 7; i++) await open(`long-component-name-for-overflow-${i}.ts`);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(760, 650);
  });
  await capture('desktop-constrained-tabs');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const selected = 'long-component-name-for-overflow-6.ts';
  const input = page.getByRole('textbox', { name: `${selected} editor`, exact: true });
  await input.focus();
  await input.press('Meta+w');
  await expect(page.getByRole('tab', { name: selected, exact: true })).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'long-component-name-for-overflow-5.ts editor', exact: true })
    .press('Meta+Shift+t');
  await expect(page.getByRole('tab', { name: selected, exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.press('End');
  await input.pressSequentially(' typed after reopen');
  await input.press('Control+Tab');
  const previous = page.getByRole('textbox', {
    name: 'long-component-name-for-overflow-5.ts editor',
    exact: true,
  });
  await expect(previous).toBeFocused();
  await previous.press('End');
  await previous.pressSequentially(' mru typing');
  await previous.press('Meta+Alt+ArrowRight');
  await expect(input).toBeFocused();
  await input.press('End');
  await input.pressSequentially(' visual typing');
  const tabs = page.getByRole('tablist', { name: 'Open files', exact: true }).getByRole('tab');
  const before = await tabs.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')),
  );
  await openTabMenu(page);
  await page.getByRole('menuitem', { name: 'Move tab left', exact: true }).click();
  const after = await tabs.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')),
  );
  expect(after.indexOf(selected)).toBe(before.indexOf(selected) - 1);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.4);
  });
  await capture('desktop-zoom');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('tablist', { name: 'Open files', exact: true })
    .getByRole('tab', { selected: true })
    .focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
  await capture('desktop-keyboard-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Find file', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox').fill('a.ts');
  await expect(page.getByRole('option', { name: 'a.ts', exact: true })).toBeVisible();
  expect(
    await page.getByRole('dialog').evaluate((element) => getComputedStyle(element).fontFamily),
  ).toBe(
    await page
      .getByLabel('Moonbase workbench', { exact: true })
      .evaluate((element) => getComputedStyle(element).fontFamily),
  );
  await capture('desktop-keyboard-dialog');
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeFocused();
  await page
    .getByRole('textbox', { name: 'a.ts editor', exact: true })
    .pressSequentially('keyboard lookup typing');
  await capture('desktop-keyboard');
  expect(errors).toEqual([]);
});

test('native Trash moves only a captured temporary fixture and leaves its dirty draft available', async () => {
  const name = `moonbase-trash-${crypto.randomUUID()}.txt`,
    content = 'CONTROLLED TRASH FIXTURE ' + name;
  writeFileSync(join(checkout, name), content);
  const inode = statSync(join(checkout, name)).ino;
  await open(name);
  await edit('retained after native Trash', name);
  await page.getByRole('treeitem', { name: name + ', unsaved', exact: true }).click();
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click();
  await expect.poll(() => existsSync(join(checkout, name))).toBe(false);
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          !!globalThis.desktopTest.results.findLast((r) => r.operation === 'mutate' && r.reply.ok),
      ),
    )
    .toBe(true);
  const result = await app.evaluate(() =>
    globalThis.desktopTest.results.findLast((r) => r.operation === 'mutate' && r.reply.ok),
  );
  const trashPath = result?.reply.value?.items
    .find((item) => item.message?.startsWith('macOS Trash: '))
    ?.message?.slice('macOS Trash: '.length);
  expect(trashPath).toBeTruthy();
  if (!trashPath) throw Error('No native Trash path recorded');
  // Cleanup touches only the exact native-returned fixture, after content and inode verification.
  try {
    expect(trashPath.split('/').at(-1)).toBe(name);
    expect(statSync(trashPath).ino).toBe(inode);
    expect(readFileSync(trashPath, 'utf8')).toBe(content);
  } finally {
    if (statSync(trashPath).ino === inode && readFileSync(trashPath, 'utf8') === content)
      rmSync(trashPath);
  }
  await open('b.ts');
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: `${name} editor`, exact: true })).toBeVisible();
  await expect(
    page.locator('.view-line').filter({ hasText: 'retained after native Trash' }).first(),
  ).toBeVisible();
  await expect
    .poll(async () => (await recovery()).state.drafts.find((d) => d.target.path === name)?.text)
    .toBe('retained after native Trash');
});

test('unknown final Quit publication retains the window and resolves only the exact committed receipt', async () => {
  await open();
  await edit('consented pending discard');
  await expect
    .poll(async () => (await recovery()).state.drafts[0]?.text)
    .toBe('consented pending discard');
  await app.evaluate(() => {
    globalThis.desktopTest.fault = 'final-publication';
  });
  await quit();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toBeVisible();
  expect((await recovery()).state.drafts).toEqual([]); // The consented final publication actually committed.
  await page.evaluate(() =>
    Object.assign(window, { pendingDocumentIdentity: crypto.randomUUID() }),
  );
  const pendingDocument = await page.evaluate(
    () => (window as unknown as { pendingDocumentIdentity: string }).pendingDocumentIdentity,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { pendingDocumentIdentity: string }).pendingDocumentIdentity,
    ),
  ).toBe(pendingDocument);
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.view-line').filter({ hasText: 'consented pending discard' }).first(),
  ).toBeVisible();
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  ).toBe(true);
  await app.evaluate(() => {
    globalThis.desktopTest.noStatus = false;
  });
  await page.getByRole('button', { name: 'Resolve recovery publication', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.view-line').filter({ hasText: 'WORKING' }).first()).toBeVisible();
  const exited = app.waitForEvent('close');
  await quit();
  await exited;
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toContain('WORKING');
});

test('a command cancelled over real IPC keeps typed cancellation and leaves unrelated IO usable', async () => {
  await open();
  const approved = await checkoutTarget();
  const cancelled = await page.evaluate(async (checkout) => {
    const id = crypto.randomUUID(),
      pending = window.moonbase.call(
        'command',
        { operation: 'readFile', input: { checkout, path: 'a.ts' } },
        id,
      );
    window.moonbase.cancel('some-other-request');
    window.moonbase.cancel(id);
    return pending;
  }, approved);
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok) expect(cancelled.error.code).toBe('Cancelled');
  const next = await page.evaluate(
    async (checkout) =>
      window.moonbase.call(
        'command',
        { operation: 'readFile', input: { checkout, path: 'b.ts' } },
        crypto.randomUUID(),
      ),
    approved,
  );
  expect(next.ok).toBe(true);
  expect(await app.evaluate(() => globalThis.desktopTest.cancels)).toBeGreaterThanOrEqual(2);
});

test('exact checkout tabs preserve independent dirty paths, views and closed metadata through native approval', async () => {
  await open();
  await edit('alpha dirty a');
  const beta = join(base, 'second-checkout');
  execFileSync('/usr/bin/git', [
    '-C',
    checkout,
    'worktree',
    'add',
    '-q',
    '-b',
    'beta',
    beta,
    'HEAD',
  ]);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, beta);
  await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'second-checkout · beta', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await open();
  await edit('beta dirty a');
  await expect.poll(async () => (await recovery()).state.drafts.length).toBe(2);
  const first = page.getByRole('tab', { name: 'checkout · main', exact: true });
  await first.click();
  await expect(
    page.locator('.view-line').filter({ hasText: 'alpha dirty a' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: `Close checkout ${checkout}`, exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(first).toBeVisible();
  await page.getByRole('button', { name: `Close checkout ${checkout}`, exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(first).toHaveCount(0);
  const closed = await recovery();
  expect(closed.state.checkouts).toHaveLength(2);
  expect(closed.state.openCheckoutIds).toHaveLength(1);
  expect(Object.values(closed.state.views).some((v) => v.openFiles.includes('a.ts'))).toBe(true);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, checkout);
  await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(first).toBeVisible();
  await expect(page.locator('.view-line').filter({ hasText: 'WORKING' }).first()).toBeVisible();
  await expect
    .poll(
      async () =>
        (await recovery()).state.drafts.find((d) => d.target.checkout.root === beta)?.text,
    )
    .toBe('beta dirty a');
});

test("single-file paste and File-backed drop share the editor's destination dialog", async () => {
  await open();
  const source = join(base, 'picked.txt');
  writeFileSync(source, 'ONE PICKED NATIVE FILE');
  await pasteNativeFile(app, page, source);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Import files', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Destination relative path').fill('picker.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Import files', exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, 'picker.txt'))).toBe(true);
  expect(readFileSync(join(checkout, 'picker.txt'), 'utf8')).toBe('ONE PICKED NATIVE FILE');
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'drop-fixture';
    document.body.append(input);
  });
  await page.locator('#drop-fixture').setInputFiles(source);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector<HTMLInputElement>('#drop-fixture')!.files![0]);
    document
      .querySelector('[aria-label="Moonbase workbench"]')!
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
  });
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  await page.getByLabel('Destination relative path').fill('drop.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Import files', exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, 'drop.txt'))).toBe(true);
  expect(readFileSync(join(checkout, 'drop.txt'), 'utf8')).toBe('ONE PICKED NATIVE FILE');
});

test('unacknowledged real move evidence restores dirty text on process restart without another mutation', async () => {
  await open();
  await edit('draft before uncertain move');
  await expect
    .poll(async () => (await recovery()).state.drafts[0]?.text)
    .toBe('draft before uncertain move');
  const inode = statSync(join(checkout, 'a.ts')).ino;
  await page.getByRole('treeitem', { name: 'a.ts, unsaved', exact: true }).click();
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Destination relative path').fill('moved.ts');
  await app.evaluate(() => {
    globalThis.desktopTest.fault = 'mutate';
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, 'moved.ts'))).toBe(true);
  await forceStop();
  await launch();
  await page.getByRole('tab', { name: 'checkout · main', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'moved.ts editor', exact: true })).toBeVisible();
  await expect(
    page.locator('.view-line').filter({ hasText: 'draft before uncertain move' }).first(),
  ).toBeVisible();
  expect(existsSync(join(checkout, 'a.ts'))).toBe(false);
  expect(statSync(join(checkout, 'moved.ts')).ino).toBe(inode);
  expect(
    await app.evaluate(
      () =>
        globalThis.desktopTest.calls.filter((call) => call.input?.operation === 'mutate').length,
    ),
  ).toBe(0);
  await expect.poll(async () => (await recovery()).operations.length).toBe(0);
  const draft = (await recovery()).state.drafts.find((d) => d.target.path === 'moved.ts');
  expect(draft?.text).toBe('draft before uncertain move');
  expect(draft?.disk.text).toContain('WORKING');
});

test('replacement consent cannot overwrite another open dirty draft or admit a native mutation', async () => {
  await open();
  await edit('SOURCE DRAFT');
  await open('b.ts');
  await edit('DESTINATION DRAFT', 'b.ts');
  await expect.poll(async () => (await recovery()).state.drafts.length).toBe(2);
  await page.getByRole('treeitem', { name: 'a.ts, unsaved', exact: true }).click();
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Destination relative path').fill('b.ts');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('button', { name: 'Replace captured destination', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert').last()).toContainText('open buffers');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    await app.evaluate(
      () =>
        globalThis.desktopTest.calls.filter((call) => call.input?.operation === 'mutate').length,
    ),
  ).toBe(0);
  expect(readFileSync(join(checkout, 'a.ts'), 'utf8')).toContain('WORKING');
  expect(readFileSync(join(checkout, 'b.ts'), 'utf8')).toContain('b = 2');
  const drafts = (await recovery()).state.drafts;
  expect(drafts.find((d) => d.target.path === 'a.ts')?.text).toBe('SOURCE DRAFT');
  expect(drafts.find((d) => d.target.path === 'b.ts')?.text).toBe('DESTINATION DRAFT');
  await capture('desktop-collision');
});

test('a file named checkout remains data when its view and draft cross the authority boundary', async () => {
  writeFileSync(join(checkout, 'checkout'), 'ordinary path data');
  await open('checkout');
  await edit('retained reserved-looking filename', 'checkout');
  await expect
    .poll(
      async () => (await recovery()).state.drafts.find((d) => d.target.path === 'checkout')?.text,
    )
    .toBe('retained reserved-looking filename');
  await saveFile(page);
  await expect
    .poll(() => readFileSync(join(checkout, 'checkout'), 'utf8'))
    .toBe('retained reserved-looking filename');
});

test('an explicit native Quit arriving before renderer startup is not lost', async () => {
  await forceStop();
  const env = {
    ...process.env,
    MOONBASE_USER_DATA: join(base, 'early-user-data'),
    MOONBASE_TEST_REPORT: join(base, 'early-quit.json'),
    MOONBASE_TEST_QUIT_EARLY: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve('test/harness.mjs')], env, timeout: 20000 });
  child = app.process();
  await app.waitForEvent('close', { timeout: 5000 });
  expect(existsSync(join(base, 'early-quit.json'))).toBe(true);
});

test('app R1 filename maps preserve actual Save, positions, sibling drafts and restart', async () => {
  for (const path of filenameCases) writeFileSync(join(checkout, path), 'baseline ' + path);
  execFileSync('/usr/bin/git', [
    '-C',
    checkout,
    '-c',
    'user.name=Filename Test',
    '-c',
    'user.email=test@example.invalid',
    'add',
    '--',
    ...filenameCases,
  ]);
  execFileSync('/usr/bin/git', [
    '-C',
    checkout,
    '-c',
    'user.name=Filename Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'Filename fixtures',
  ]);
  await open();
  let evidence;
  try {
    evidence = await checkFilenameMaps(page, checkout, 'a.ts', async () => {
      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await forceStop();
      await launch();
      await page.getByRole('tab', { name: 'checkout · main', exact: true }).click();
      return page;
    });
  } finally {
    writeFileSync(
      'test-results/filename-bridge-inputs.json',
      (await app.evaluate(() =>
        JSON.stringify(
          { calls: globalThis.desktopTest.calls, results: globalThis.desktopTest.results },
          null,
          2,
        ),
      )) + '\n',
    );
  }
  writeFileSync('test-results/filename-maps.json', JSON.stringify(evidence, null, 2) + '\n');
  await capture('desktop-filename-maps');
});

test('app R1 context-isolated command transport preserves own JSON keys', async () => {
  expect(
    await page.evaluate(() => {
      const map = {};
      Object.defineProperty(map, '__proto__', {
        value: 'staged',
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return Object.keys(structuredClone(map));
    }),
  ).toEqual(['__proto__']);
  const reply = await page.evaluate(() =>
    window.moonbase.call(
      'command',
      {
        operation: 'unknown',
        input: JSON.parse(
          '{"__proto__":{"marker":1},"constructor":2,"fileViews":{"__proto__":"staged"},"positions":{"__proto__":{"staged":{"line":1,"column":3,"top":0,"left":0}}},"state":{"views":{"known":{"fileViews":{"__proto__":"staged"},"positions":{"__proto__":{"staged":{"line":1,"column":3,"top":0,"left":0}}}}}}}',
        ),
      },
      crypto.randomUUID(),
    ),
  );
  expect(reply.ok).toBe(false);
  const result = await app.evaluate(() => {
    const input = globalThis.desktopTest.calls.at(-1)!.input.input!;
    return {
      own: Object.hasOwn(input, '__proto__'),
      fileViews: Object.keys(input.fileViews as object),
      positions: Object.keys(input.positions as object),
      deep: Object.keys(
        (input.state as { views: { known: { fileViews: object } } }).views.known.fileViews,
      ),
    };
  });
  writeFileSync('test-results/own-keys-boundary.json', JSON.stringify(result, null, 2) + '\n');
  expect(result).toEqual({
    own: true,
    fileViews: ['__proto__'],
    positions: ['__proto__'],
    deep: ['__proto__'],
  });
});

test('app R1 Tab actions first/last selection and Close click work at native size and zoom', async () => {
  await open('b.ts');
  await open();
  await page.getByRole('tab', { name: 'b.ts', exact: true }).hover();
  await page.getByRole('button', { name: 'Close b.ts', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'b.ts', exact: true })).toHaveCount(0);
  await checkTabMenu(app, page, (name) => capture('desktop-' + name));
});
