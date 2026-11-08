import type { Locator } from '@playwright/test';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import type { RecoveryLoad } from '@moonbase/contracts/workspace';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

/** Runs one of the explorer's "…" menu actions: New File…, Go to File…, Refresh and so on. */
export async function explorerAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'Explorer actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function openTabMenu(editor: Page | Locator) {
  await editor
    .getByRole('tablist', { name: 'Open files', exact: true })
    .getByRole('tab', { selected: true })
    .click({ button: 'right' });
}

export async function saveFile(editor: Page | Locator) {
  await editor.getByRole('textbox', { name: / editor$/ }).press('Meta+s');
}

export async function selectFileView(editor: Page | Locator, view: string) {
  const page = 'page' in editor ? editor.page() : editor;
  await openTabMenu(editor);
  await page.getByRole('menuitem', { name: 'File view', exact: true }).click();
  await page
    .getByRole('menuitemradio', { name: view === 'file' ? 'File' : view, exact: true })
    .click();
}

export async function expectSaveEnabled(editor: Page | Locator, enabled: boolean) {
  const page = 'page' in editor ? editor.page() : editor;
  await openTabMenu(editor);
  const action = page.getByRole('menuitem', { name: 'Save', exact: true });
  if (enabled) await expect(action).toBeEnabled();
  else await expect(action).toBeDisabled();
  await page.keyboard.press('Escape');
}

export const filenameCases = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
export const recoveryState = async (page: Page): Promise<RecoveryLoad> =>
  JSON.parse(
    await page.evaluate(async () => {
      const reply = await window.moonbase.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: window.moonbase.clientId } },
        crypto.randomUUID(),
      );
      if (!reply.ok) throw Error(reply.error.message);
      // Preserve own __proto__ keys across Playwright's evaluation-result serializer.
      return JSON.stringify(reply.value);
    }),
  );
const prototypes = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify(
      [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty].map(
        (value) => Object.getOwnPropertyDescriptors(value),
      ),
      (_key, value) =>
        typeof value === 'function' ? Function.prototype.toString.call(value) : value,
    ),
  );

/** Actual UI and bridge observations, shared by built-Electron and packaged journeys. */
export async function checkFilenameMaps(
  page: Page,
  checkout: string,
  sibling: string,
  restart: () => Promise<Page>,
) {
  const before = await prototypes(page);
  const edit = async (path: string, text: string) => {
    const input = page.getByRole('textbox', { name: path + ' editor', exact: true });
    await input.focus();
    await input.press('Meta+a');
    await input.pressSequentially(text);
  };
  await edit(sibling, 'retained sibling draft');
  for (const path of filenameCases) {
    await explorerAction(page, 'Go to File…');
    await page.getByRole('combobox').fill(path);
    await expect(page.getByRole('option', { name: path, exact: true })).toBeVisible();
    await page.getByRole('option', { name: path, exact: true }).click();
    const input = page.getByRole('textbox', { name: path + ' editor', exact: true });
    await input.focus();
    await input.press('ArrowRight');
    expect(await prototypes(page)).toBe(before);
    await edit(path, 'saved ' + path);
    await saveFile(page);
    await expect.poll(() => readFileSync(checkout + '/' + path, 'utf8')).toBe('saved ' + path);
    await selectFileView(page, 'staged');
    await expect(page.getByRole('textbox', { name: / original$/ })).toHaveJSProperty(
      'readOnly',
      true,
    );
    await edit(path, 'dirty ' + path);
    await input.press('ArrowLeft');
  }
  await expect.poll(async () => (await recoveryState(page)).state.drafts.length).toBe(5);
  for (const path of filenameCases) {
    await expect
      .poll(
        async () =>
          (await recoveryState(page)).state.views[
            (await recoveryState(page)).state.selectedCheckoutId!
          ].positions[path]?.staged?.column,
      )
      .toBeGreaterThan(1);
  }
  const persisted = (await recoveryState(page)).state,
    view = persisted.views[persisted.selectedCheckoutId!];
  for (const path of filenameCases) {
    expect(Object.hasOwn(view.fileViews, path)).toBe(true);
    expect(view.fileViews[path]).toBe('staged');
    expect(Object.hasOwn(view.positions, path)).toBe(true);
  }
  expect(await prototypes(page)).toBe(before);
  page = await restart();
  await expect(
    page.getByRole('textbox', { name: 'hasOwnProperty editor', exact: true }),
  ).toBeVisible();
  const restarted = (await recoveryState(page)).state,
    restored = restarted.views[restarted.selectedCheckoutId!];
  for (const path of filenameCases) {
    await page.getByRole('tab', { name: path, exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'HEAD ↔ working buffer original', exact: true }),
    ).toBeVisible();
    expect(restored.fileViews[path]).toBe('staged');
    await expect(page.getByRole('textbox', { name: / original$/ })).toHaveJSProperty(
      'readOnly',
      true,
    );
    await expect(
      page
        .locator('.view-line')
        .filter({ hasText: 'dirty ' + path })
        .first(),
    ).toBeVisible();
    expect(restarted.drafts.find((draft) => draft.target.path === path)?.disk.text).toBe(
      'saved ' + path,
    );
    expect(restored.positions[path].staged).toEqual(view.positions[path].staged);
  }
  expect(await prototypes(page)).toBe(before);
  await page.getByRole('tab', { name: sibling, exact: true }).click();
  await expect(
    page.locator('.view-line').filter({ hasText: 'retained sibling draft' }).first(),
  ).toBeVisible();
  const protoTab = page.getByRole('tab', { name: '__proto__', exact: true });
  await protoTab.click();
  await expect(protoTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '__proto__ editor', exact: true })).toBeVisible();
  await saveFile(page);
  await expect.poll(() => readFileSync(checkout + '/__proto__', 'utf8')).toBe('dirty __proto__');
  await expect.poll(async () => (await recoveryState(page)).state.drafts.length).toBe(4);
  return {
    unchangedPrototypes: true,
    persisted,
    restarted,
    afterSave: (await recoveryState(page)).state,
  };
}

export async function checkTabMenu(
  app: ElectronApplication,
  page: Page,
  capture: (name: string) => Promise<void>,
  reopened = 'b.ts',
) {
  const records = [];
  for (const [name, width, height, zoom] of [
    ['normal', 1280, 850, 1],
    ['small', 760, 650, 1],
    ['zoom', 760, 650, 1.4],
  ] as const) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
        window.webContents.setZoomFactor(size.zoom);
      },
      { width, height, zoom },
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom));
    const trigger = page
      .getByRole('tablist', { name: 'Open files', exact: true })
      .getByRole('tab', { selected: true });
    await trigger.focus();
    await trigger.press('Shift+F10');
    await page.keyboard.press('Home');
    const first = page.getByRole('menuitem', { name: 'Keep Open', exact: true });
    await expect(first).toBeFocused();
    expect(
      await first.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    await capture('menu-first-' + name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.press('Shift+F10');
    await expect(first).toBeFocused();
    await page.keyboard.press('End');
    const last = page.getByRole('menuitem', { name: 'Reopen Closed Files', exact: true });
    await expect(last, name).toBeFocused();
    expect(
      await last.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    await capture('menu-last-' + name);
    const geometry = await page.getByRole('menu').evaluate((element) => ({
      viewport: { width: innerWidth, height: innerHeight },
      popup: element.getBoundingClientRect().toJSON(),
      overflowY: getComputedStyle(element).overflowY,
    }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: reopened, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('textbox', { name: reopened + ' editor', exact: true }),
    ).toBeVisible();
    await trigger.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: reopened, exact: true })).toHaveCount(0);
    records.push({ name, width, height, zoom, geometry });
  }
  writeFileSync('test-results/menu-geometry.json', JSON.stringify(records, null, 2) + '\n');
}

export async function captureNative(app: ElectronApplication, page: Page, file: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const native = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      png: (await window.webContents.capturePage()).toPNG().toString('base64'),
      bounds: window.getBounds(),
      content: window.getContentBounds(),
      zoom: window.webContents.getZoomFactor(),
    };
  });
  const bytes = Buffer.from(native.png, 'base64');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  writeFileSync(
    file + '.json',
    JSON.stringify(
      {
        ...native,
        png: undefined,
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio,
        })),
        size: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
        sha256: createHash('sha256').update(bytes).digest('hex'),
        fixture: test.info().title,
      },
      null,
      2,
    ) + '\n',
  );
}

export async function prepareCrashRecovery(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = ((_window: unknown, options: { buttons: string[] }) => {
      globalThis.recoveryButtons = options.buttons;
      return new Promise((resolve) => {
        globalThis.recoveryChoice = resolve;
      });
    }) as typeof dialog.showMessageBox;
  });
}
export async function recoverCrashedWorkbench(app: ElectronApplication) {
  await expect
    .poll(() => app.evaluate(() => globalThis.recoveryButtons))
    .toEqual(['Recover workbench', 'Quit Moonbase']);
  await app.evaluate(() => globalThis.recoveryChoice!({ response: 0, checkboxChecked: false }));
}

export async function pasteNativeFile(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ clipboard, dialog, ClipboardItem }, path) => {
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
    const escaped = path.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array><string>${escaped}</string></array></plist>`;
    clipboard.read = async () => [
      new ClipboardItem({
        'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([xml]),
      }),
    ];
  }, path);
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
}
