import { test, expect, type Page } from '@playwright/test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';

declare global {
  interface Window {
    finishMenuOpening(): Promise<void>;
    releaseTreeScroll(): void;
    resumeMenuFrames(): number;
    releaseMenuFocus(): void;
  }
}

async function holdMenuOpening(page: Page) {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const popup = document.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]');
      if (!popup) return;
      // Release a real opening animation explicitly so keyboard input can precede completion.
      const animation = popup.animate([{}, {}], { duration: 1 });
      animation.pause();
      window.finishMenuOpening = async () => {
        animation.finish();
        await animation.finished;
      };
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

async function holdMenuFocus(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      'contextmenu',
      () => {
        const request = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        const frames = new Map<number, FrameRequestCallback>();
        let id = 0;
        window.requestAnimationFrame = (callback) => {
          frames.set(--id, callback);
          return id;
        };
        window.cancelAnimationFrame = (handle) => {
          if (!frames.delete(handle)) cancel(handle);
        };
        window.resumeMenuFrames = () => {
          window.requestAnimationFrame = request;
          return frames.size;
        };
        window.releaseMenuFocus = () => {
          window.requestAnimationFrame = request;
          window.cancelAnimationFrame = cancel;
          for (const callback of frames.values()) request(callback);
          frames.clear();
        };
      },
      { once: true, capture: true },
    );
  });
}

const region = (page: Page) =>
  page.getByRole('region', { name: 'First editor', exact: true, includeHidden: true });
const tree = (page: Page) =>
  region(page).getByRole('tree', { name: 'Files', exact: true, includeHidden: true });
const row = (page: Page, path: string) =>
  tree(page).getByRole('treeitem', { name: path, exact: true, includeHidden: true });
const menu = (page: Page) =>
  page.getByRole('menu', { name: 'File actions', exact: true, includeHidden: true });
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });
const selected = (page: Page) =>
  page.evaluate(
    () =>
      window.demo.first.getSnapshot().recovery.views[window.demo.checkout.checkoutId].tree.selected,
  );

test('row secondary and Control-click target without opening, listing or toggling folders', async ({
  page,
}) => {
  await page.goto('/');
  await expect(row(page, 'src')).toBeVisible();
  await page.evaluate(() => {
    const { first } = window.demo;
    first.open = () => {
      throw new Error('Context gesture opened a file');
    };
    first.list = () => {
      throw new Error('Context gesture listed a folder');
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const path of ['README.md', 'src']) {
    await row(page, path).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(row(page, path)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(tree(page)).toBeFocused();
    // Only macOS Chromium turns Control-click into a context menu.
    if (process.platform !== 'darwin') continue;
    await row(page, path).click({ modifiers: ['Control'] });
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  await expect(region(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(errors).toEqual([]);
});

for (const shortcut of ['ContextMenu', 'Shift+F10'])
  test(`${shortcut} targets logical focus and menu keys stay out of the tree`, async ({ page }) => {
    await page.goto('/');
    await expect(row(page, 'README.md')).toBeVisible();
    await tree(page).focus();
    await tree(page).press('Home');
    await tree(page).press(shortcut);
    // The first row is a folder, whose menu starts with what can be made inside it.
    await expect(item(page, 'New File…')).toBeFocused();
    const captured = await selected(page);
    await page.keyboard.press('End');
    await expect(item(page, 'Move to Trash')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item(page, 'New File…')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'New Folder…')).toBeFocused();
    await page.keyboard.press('m');
    await expect(item(page, 'Move to Trash')).toBeFocused();
    expect(await selected(page)).toEqual(captured);
    await page.keyboard.press('Escape');
    await expect(tree(page)).toBeFocused();
    await expect(tree(page)).toHaveAttribute(
      'aria-activedescendant',
      (await row(page, captured[0]).getAttribute('id')) as string,
    );
  });

test('selected rows retain the range anchor; unselected rows replace it', async ({ page }) => {
  await page.goto('/');
  await tree(page).focus();
  await tree(page).press('Home');
  await tree(page).press('Shift+ArrowDown');
  const paths = await selected(page);
  await row(page, paths[1]).click({ button: 'right' });
  expect(await selected(page)).toEqual(paths);
  // Single-item actions leave the menu; the rest name how many items they act on.
  await expect(item(page, 'Rename…')).toHaveCount(0);
  await expect(item(page, 'Duplicate…')).toHaveCount(0);
  await expect(item(page, 'Copy Paths')).toBeVisible();
  await expect(item(page, 'Move 2 Items to Trash')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await tree(page).press('Shift+ArrowUp');
  expect(await selected(page)).toEqual(paths.slice(0, 1));
  await row(page, 'README.md').click({ button: 'right' });
  expect(await selected(page)).toEqual(['README.md']);
  await page.keyboard.press('Escape');
  await tree(page).press('Shift+ArrowDown');
  expect(await selected(page)).toEqual(['README.md', 'welcome.ts']);
});

for (const [name, title] of [
  ['Rename…', 'Rename'],
  ['Duplicate…', 'Duplicate'],
  ['Move to Trash', 'Move to Trash'],
])
  test(`${name} hands focus to its existing dialog and Cancel returns to this tree`, async ({
    page,
  }) => {
    await page.goto('/');
    await row(page, 'README.md').click({ button: 'right' });
    await item(page, name).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('memory-demo · /demo/moonbase');
    await expect(dialog).toContainText('README.md');
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tree(page)).toBeFocused();
    expect(await page.evaluate(() => window.demo.memory.stats.mutations)).toBe(0);
  });

for (const key of ['Tab', 'Shift+Tab'])
  test(`${key} dismisses and traverses from the invoking tree without activation`, async ({
    page,
  }) => {
    await page.goto('/');
    await tree(page).focus();
    await tree(page).press('Home');
    await tree(page).press('ContextMenu');
    await expect(item(page, 'New File…')).toBeFocused();
    await page.keyboard.press(key);
    await expect(menu(page)).toHaveCount(0);
    await expect(
      key === 'Tab'
        ? region(page).getByRole('tab', { name: 'welcome.ts', exact: true })
        : region(page).getByRole('button', { name: 'Changes', exact: true }),
    ).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

test('outside dismissal consumes the row click; background invocation stays native', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  const bounds = await row(page, 'src').boundingBox();
  await page.mouse.click(bounds!.x + 80, bounds!.y + 14);
  await expect(menu(page)).toHaveCount(0);
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  expect(await selected(page)).toEqual(['README.md']);
  expect(
    await tree(page).evaluate((element) =>
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    ),
  ).toBe(true);
  await expect(menu(page)).toHaveCount(0);
});

for (const timing of ['normal', 'pending scroll'])
  test(`large-tree menus capture all offscreen paths and keep row virtualization (${timing})`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(tree(page)).toBeVisible();
    await page.evaluate(async () => {
      const { first, client, checkout } = window.demo;
      const command = client.command.bind(client);
      client.command = async (name, input, options) => {
        const result = await command(name, input, options);
        if (name === 'listDirectory' && (input as { path: string }).path === '')
          (result as DirectoryListing).entries = Array.from({ length: 10000 }, (_, index) => ({
            path: `file-${String(index).padStart(5, '0')}`,
            directory: false,
          }));
        return result;
      };
      await first.list(checkout);
    });
    if (timing === 'pending scroll')
      await tree(page).evaluate((element) => {
        element.addEventListener(
          'scroll',
          (event) => {
            event.stopImmediatePropagation();
            window.releaseTreeScroll = () => element.dispatchEvent(event);
          },
          { once: true, capture: true },
        );
      });
    await tree(page).focus();
    await tree(page).press('Home');
    await tree(page).press('Shift+End');
    if (timing === 'pending scroll') await page.waitForFunction(() => !!window.releaseTreeScroll);
    await tree(page).press('ContextMenu');
    await expect(menu(page)).toBeVisible();
    if (timing === 'pending scroll') await page.evaluate(() => window.releaseTreeScroll());
    await expect(menu(page)).toBeVisible();
    expect(await tree(page).getByRole('treeitem').count()).toBeLessThan(80);
    expect(await selected(page)).toHaveLength(10000);
    await item(page, 'Move 10000 Items to Trash').click();
    const dialog = page.getByRole('dialog', { name: 'Move to Trash', exact: true });
    await expect(dialog).toContainText('file-00000');
    await expect(dialog).toContainText('file-09999');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row(page, 'file-09999').click({ button: 'right' });
    await tree(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(menu(page)).toHaveCount(0);
  });

test('menus dismiss on hide, target loss, checkout navigation and unmount', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await page.evaluate(() =>
    (
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Hide first editor',
      ) as HTMLButtonElement
    ).click(),
  );
  await expect(menu(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show first editor', exact: true }).click();
  await row(page, 'README.md').click({ button: 'right' });
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    const sources = await first.inspect(checkout, ['README.md']);
    await first.mutate({ checkout, kind: 'trash', sources, replacements: [] });
  });
  await expect(menu(page)).toHaveCount(0);
  const second = page.getByRole('region', { name: 'Second editor', exact: true });
  await second
    .getByRole('treeitem', { name: 'welcome.ts', exact: true })
    .click({ button: 'right' });
  await page.evaluate(() =>
    (
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Dispose second editor',
      ) as HTMLButtonElement
    ).click(),
  );
  await expect(menu(page)).toHaveCount(0);
  await page.goto('/recovery-race.html');
  const currentTree = page.getByRole('tree', { name: 'Files', exact: true });
  await currentTree.getByRole('treeitem', { name: 'a.ts', exact: true }).click({ button: 'right' });
  await page.evaluate(async () => {
    const editor = window.recoveryRace.editor;
    await editor.selectCheckout(
      editor.getSnapshot().recovery.checkouts.find((target) => target.checkoutId === 'beta')!,
    );
  });
  await expect(menu(page)).toHaveCount(0);
});

test('a captured dialog survives navigation and refuses a closed checkout without stealing focus', async ({
  page,
}) => {
  await page.goto('/recovery-race.html');
  const currentTree = page.getByRole('tree', { name: 'Files', exact: true });
  await currentTree.getByRole('treeitem', { name: 'a.ts', exact: true }).click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate', exact: true });
  await page.evaluate(async () => {
    const editor = window.recoveryRace.editor;
    const alpha = editor
      .getSnapshot()
      .recovery.checkouts.find((target) => target.checkoutId === 'alpha')!;
    const beta = editor
      .getSnapshot()
      .recovery.checkouts.find((target) => target.checkoutId === 'beta')!;
    await editor.selectCheckout(beta);
    await editor.closeCheckout(alpha);
  });
  await expect(dialog).toContainText('memory · /race/alpha');
  await expect(dialog.getByRole('alert')).toContainText('captured checkout is unavailable');
  await dialog.getByLabel('Destination relative path', { exact: true }).fill('copy.ts');
  await expect(dialog.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(currentTree).not.toBeFocused();
});

test('two workbenches keep menu selection, dialogs and return focus independent', async ({
  page,
}) => {
  await page.goto('/');
  const second = page.getByRole('region', { name: 'Second editor', exact: true });
  const otherTree = second.getByRole('tree', { name: 'Files', exact: true });
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  await expect(page.getByRole('dialog', { name: 'Duplicate', exact: true })).toContainText(
    'README.md',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tree(page)).toBeFocused();
  await otherTree.getByRole('treeitem', { name: 'src', exact: true }).click({ button: 'right' });
  await item(page, 'Move to Trash').click();
  await expect(page.getByRole('dialog')).toContainText('src');
  expect(await selected(page)).toEqual(['README.md']);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(otherTree).toBeFocused();
});

test('controlled remote host and local checkout with matching IDs and paths stay isolated', async ({
  page,
}) => {
  await page.goto('/?remote');
  const otherTree = page
    .getByRole('region', { name: 'Second editor', exact: true })
    .getByRole('tree', { name: 'Files', exact: true });
  await otherTree
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate', exact: true });
  await expect(dialog).toContainText('remote-memory · /demo/remote');
  await dialog.getByLabel('Destination relative path', { exact: true }).fill('remote-copy.md');
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    otherTree.getByRole('treeitem', { name: 'remote-copy.md', exact: true }),
  ).toBeVisible();
  await expect(row(page, 'remote-copy.md')).toHaveCount(0);
});

test('portal typing and paste do not import files or navigate the explorer', async ({ page }) => {
  await page.goto('/?clipboard');
  await expect(tree(page)).toBeVisible();
  await page.evaluate(() => {
    window.demo.selectClipboardImports = async () => {
      throw new Error('Menu paste imported files');
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await row(page, 'README.md').click({ button: 'right' });
  await expect(item(page, 'Open')).toBeFocused();
  expect(
    await item(page, 'Open').evaluate((element) => {
      const key = new KeyboardEvent('keydown', {
        key: 'v',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(key);
      const data = new DataTransfer();
      data.setData('text/plain', 'controlled menu paste');
      const paste = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(paste);
      return { keyPrevented: key.defaultPrevented, pastePrevented: paste.defaultPrevented };
    }),
  ).toEqual({ keyPrevented: false, pastePrevented: false });
  await page.keyboard.press('d');
  await expect(item(page, 'Duplicate…')).toBeFocused();
  expect(await selected(page)).toEqual(['README.md']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(region(page).getByRole('alert', { includeHidden: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('eligibility updates during preservation and disabled actions cannot execute', async ({
  page,
}) => {
  await page.goto('/recovery-race.html');
  await page.getByRole('treeitem', { name: 'a.ts', exact: true }).click({ button: 'right' });
  await page.evaluate(() => {
    const { editor } = window.recoveryRace;
    const checkout = editor
      .getSnapshot()
      .recovery.checkouts.find((target) => target.checkoutId === 'alpha')!;
    window.recoveryRace.hold();
    void editor.close([{ checkout, path: 'b.ts' }]);
  });
  await expect(item(page, 'Duplicate…')).toHaveAttribute('aria-disabled', 'true');
  await item(page, 'Duplicate…').dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: 'Duplicate', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.recoveryRace.release());
  await expect
    .poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving))
    .toBe(false);
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await expect(item(page, 'Duplicate…')).toBeEnabled();
});

test('another file saving does not disable an unrelated row mutation', async ({ page }) => {
  await page.goto('/');
  await expect(row(page, 'README.md')).toBeVisible();
  await page.evaluate(() => {
    const { first, checkout, client } = window.demo;
    const command = client.command.bind(client);
    client.command = async (name, input, options) => {
      if (name === 'saveFile') await new Promise<void>(() => {});
      return command(name, input, options);
    };
    first.edit({ checkout, path: 'welcome.ts' }, 'saving');
    void first.save({ checkout, path: 'welcome.ts' });
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.demo.first.getSnapshot().buffers.some((buffer) => buffer.saving)),
    )
    .toBe(true);
  await row(page, 'README.md').click({ button: 'right' });
  await expect(item(page, 'Duplicate…')).not.toHaveAttribute('aria-disabled', 'true');
  await item(page, 'Duplicate…').click();
  await expect(page.getByRole('dialog', { name: 'Duplicate', exact: true })).toBeVisible();
});

test('a competing preservation dialog dismisses the menu and owns focus and the first click', async ({
  page,
}) => {
  await page.goto('/');
  await expect(row(page, 'README.md')).toBeVisible();
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.edit({ checkout, path: 'welcome.ts' }, 'Retained dirty text');
  });
  await row(page, 'README.md').click({ button: 'right' });
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    void first.close([{ checkout, path: 'welcome.ts' }]);
  });
  const dialog = page.getByRole('dialog', { name: 'Save changes before closing?', exact: true });
  await expect(menu(page)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.demo.first
          .getSnapshot()
          .buffers.find((buffer) => buffer.target.path === 'welcome.ts')?.text,
    ),
  ).toBe('Retained dirty text');
});

test('an externally opened mutation dialog dismisses an unchosen menu without returning tree focus', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await page.evaluate(() =>
    window.demo.workbench().importFiles(window.demo.checkout, ['opaque-fixture']),
  );
  await expect(menu(page)).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: 'Import files', exact: true });
  await expect(dialog.getByLabel('Destination relative path', { exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

for (const timing of ['focused', 'pending focus'])
  test(`another workbench preservation dialog dismisses the menu and owns the first click (${timing})`, async ({
    page,
  }) => {
    if (timing === 'pending focus') await holdMenuFocus(page);
    await page.goto('/');
    await row(page, 'README.md').click({ button: 'right' });
    if (timing === 'pending focus')
      expect(await page.evaluate(() => window.resumeMenuFrames())).toBeGreaterThan(0);
    else await expect(item(page, 'Open')).toBeFocused();
    await page.evaluate(() => {
      const { second, checkout } = window.demo;
      second.edit({ checkout, path: 'welcome.ts' }, 'Other editor dirty text');
      void second.close([{ checkout, path: 'welcome.ts' }]);
    });
    const dialog = page.getByRole('dialog', { name: 'Save changes before closing?', exact: true });
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    if (timing === 'pending focus') await page.evaluate(() => window.releaseMenuFocus());
    await expect(menu(page)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tree(page)).not.toBeFocused();
    expect(
      await page.evaluate(
        () =>
          window.demo.second
            .getSnapshot()
            .buffers.find((buffer) => buffer.target.path === 'welcome.ts')?.text,
      ),
    ).toBe('Other editor dirty text');
  });

for (const timing of ['normal', 'before completion', 'late completion'])
  test(`keyboard activation runs the captured action after later selection changes (${timing})`, async ({
    page,
  }) => {
    if (timing !== 'normal') await holdMenuOpening(page);
    await page.goto('/');
    await row(page, 'README.md').click({ button: 'right' });
    if (timing !== 'normal') await page.waitForFunction(() => !!window.finishMenuOpening);
    if (timing === 'late completion') await menu(page).press('Home');
    else await expect(item(page, 'Open')).toBeFocused();
    await page.evaluate(() =>
      window.demo.first.tree(window.demo.checkout, {
        selected: ['welcome.ts'],
        focus: 'welcome.ts',
      }),
    );
    // Open, Mention in Chat, Rename…, Duplicate…
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Duplicate…')).toBeFocused();
    if (timing === 'late completion') {
      await page.evaluate(() => window.finishMenuOpening());
      await expect(item(page, 'Duplicate…')).toBeFocused();
    }
    await page.keyboard.press('Space');
    if (timing === 'before completion') await page.evaluate(() => window.finishMenuOpening());
    const dialog = page.getByRole('dialog', { name: 'Duplicate', exact: true });
    await expect(dialog).toContainText('README.md');
    await dialog.getByLabel('Destination relative path', { exact: true }).fill('copied.md');
    await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        async () =>
          (
            await window.demo.client.command('readFile', {
              checkout: window.demo.checkout,
              path: 'copied.md',
            })
          ).text,
      ),
    ).toContain('# Volatile demo');
  });

test('empty-tree keyboard invocations remain unhandled', async ({ page }) => {
  await page.goto('/');
  await expect(tree(page)).toBeVisible();
  await page.evaluate(async () => {
    const { first, client, checkout } = window.demo;
    const command = client.command.bind(client);
    client.command = async (name, input, options) => {
      const result = await command(name, input, options);
      if (name === 'listDirectory') (result as DirectoryListing).entries = [];
      return result;
    };
    await first.list(checkout);
  });
  await tree(page).focus();
  for (const key of ['ContextMenu', 'F10'])
    expect(
      await tree(page).evaluate(
        (element, key) =>
          element.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              shiftKey: key === 'F10',
              bubbles: true,
              cancelable: true,
            }),
          ),
        key,
      ),
    ).toBe(true);
  await expect(menu(page)).toHaveCount(0);
  await expect(tree(page)).not.toHaveAttribute('aria-activedescendant');
});

test('nested folder invocation preserves expansion and full relative paths', async ({ page }) => {
  await page.goto('/');
  await expect(row(page, 'src')).toBeVisible();
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-directory',
      sources: [],
      destination: 'src/nested',
      replacements: [],
    });
    await first.list(checkout, 'src');
    first.tree(checkout, { expanded: ['src'] });
  });
  await row(page, 'src/nested').click({ button: 'right' });
  await expect(row(page, 'src/nested')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'src/nested')).toHaveAttribute('aria-level', '2');
  await item(page, 'Rename…').click();
  await expect(page.getByLabel('Destination relative path', { exact: true })).toHaveValue(
    'src/nested',
  );
});

for (const width of [1440, 768, 390])
  test(`menu positioning stays within the ${width}px viewport and uses highlighted states`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 650 });
    await page.goto('/');
    await expect(row(page, 'README.md')).toBeVisible();
    await row(page, 'README.md').evaluate(
      (element, width) =>
        element.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: width - 2,
            clientY: 648,
          }),
        ),
      width,
    );
    await expect(item(page, 'Open')).toBeFocused();
    await expect(item(page, 'Open')).toHaveCSS('background-color', 'rgb(32, 34, 43)');
    await expect
      .poll(() =>
        menu(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          // Opened at the bottom-right corner, it flips up and left to stay on screen.
          return (
            rect.left >= innerWidth - rect.width - 12 &&
            rect.top >= innerHeight - rect.height - 12 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.screenshot({ path: `test-results/file-menu-${width}.png` });
  });

const menuItems = (page: Page) =>
  menu(page).evaluate((element) =>
    [...element.querySelectorAll('[role="menuitem"], [role="separator"]')].map((node) =>
      node.getAttribute('role') === 'separator'
        ? '—'
        : `${node.querySelector('span:nth-child(2)')!.textContent}${
            node.getAttribute('aria-keyshortcuts')
              ? ` [${node.getAttribute('aria-keyshortcuts')}]`
              : ''
          }`,
    ),
  );

test('file, folder and multi-item menus group their own commands with shortcuts', async ({
  page,
}) => {
  await page.goto('/');
  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder';
  await row(page, 'README.md').click({ button: 'right' });
  expect(await menuItems(page)).toEqual([
    'Open [Enter]',
    '—',
    'Mention in Chat',
    '—',
    'Rename… [F2]',
    'Duplicate…',
    'Copy Path [Alt+Meta+C]',
    'Copy Relative Path [Shift+Alt+Meta+C]',
    `${reveal} [Alt+Meta+R]`,
    '—',
    'Move to Trash [Meta+Backspace]',
  ]);
  await page.keyboard.press('Escape');
  await row(page, 'src').click({ button: 'right' });
  expect(await menuItems(page)).toEqual([
    'New File…',
    'New Folder…',
    '—',
    'Rename… [F2]',
    'Copy Path [Alt+Meta+C]',
    'Copy Relative Path [Shift+Alt+Meta+C]',
    `${reveal} [Alt+Meta+R]`,
    '—',
    'Move to Trash [Meta+Backspace]',
  ]);
  await page.keyboard.press('Escape');
  await tree(page).focus();
  await tree(page).press('Home');
  await tree(page).press('Shift+End');
  const all = await selected(page);
  await tree(page).press('ContextMenu');
  const files = all.filter((path) => path !== 'src');
  expect(await menuItems(page)).toEqual([
    `Mention ${files.length} Files in Chat`,
    '—',
    'Copy Paths [Alt+Meta+C]',
    'Copy Relative Paths [Shift+Alt+Meta+C]',
    '—',
    `Move ${all.length} Items to Trash [Meta+Backspace]`,
  ]);
  // The second editor's shell supplies no clipboard, file manager or chat.
  await page.keyboard.press('Escape');
  await page
    .getByRole('region', { name: 'Second editor', exact: true })
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click({ button: 'right' });
  expect(await menuItems(page)).toEqual([
    'Open [Enter]',
    '—',
    'Rename… [F2]',
    'Duplicate…',
    '—',
    'Move to Trash [Meta+Backspace]',
  ]);
});

test('copy, reveal and mention reach the shell and copy returns focus to the tree', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Copy Path').click();
  await expect(menu(page)).toHaveCount(0);
  await expect(tree(page)).toBeFocused();
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Copy Relative Path').click();
  await row(page, 'src').click({ button: 'right' });
  await item(page, process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder').click();
  await expect(tree(page)).toBeFocused();
  await tree(page).press('Home');
  await tree(page).press('Shift+End');
  await tree(page).press('ContextMenu');
  await menu(page)
    .getByRole('menuitem', { name: /^Mention \d+ Files in Chat$/ })
    .click();
  const files = (await selected(page)).filter((path) => path !== 'src');
  expect(
    await page.evaluate(() => ({
      copied: window.demo.copied,
      revealed: window.demo.revealed,
      mentioned: window.demo.mentioned,
    })),
  ).toEqual({
    copied: ['/demo/moonbase/README.md', 'README.md'],
    revealed: ['/demo/moonbase/src'],
    mentioned: [files],
  });
});

test('tree shortcuts run the selection’s menu commands', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const rename = page.getByRole('dialog', { name: 'Rename', exact: true });
  await expect(rename.getByLabel('Destination relative path', { exact: true })).toHaveValue(
    'README.md',
  );
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tree(page)).toBeFocused();
  await tree(page).press('ControlOrMeta+Alt+KeyC');
  await tree(page).press('ControlOrMeta+Alt+Shift+KeyC');
  await tree(page).press('ControlOrMeta+Alt+KeyR');
  expect(await page.evaluate(() => [window.demo.copied, window.demo.revealed])).toEqual([
    ['/demo/moonbase/README.md', 'README.md'],
    ['/demo/moonbase/README.md'],
  ]);
  await tree(page).press('ControlOrMeta+Backspace');
  const trash = page.getByRole('dialog', { name: 'Move to Trash', exact: true });
  await expect(trash).toContainText('README.md');
  await trash.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.demo.memory.stats.mutations)).toBe(0);
});

test('New File… and New Folder… on a folder start inside it', async ({ page }) => {
  await page.goto('/');
  for (const [name, title] of [
    ['New File…', 'New File'],
    ['New Folder…', 'New Folder'],
  ]) {
    await row(page, 'src').click({ button: 'right' });
    await item(page, name).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog.getByLabel('Destination relative path', { exact: true })).toHaveValue(
      'src/',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('Open keeps focus in the tree, like Enter', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Open').click();
  await expect(region(page).getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(tree(page)).toBeFocused();
});

test('a selected folder a collapse has hidden still counts as a folder', async ({ page }) => {
  await page.goto('/');
  await expect(row(page, 'src')).toBeVisible();
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-directory',
      sources: [],
      destination: 'src/nested',
      replacements: [],
    });
    await first.list(checkout, 'src');
    first.tree(checkout, { expanded: ['src'] });
  });
  await expect(row(page, 'src/nested')).toBeVisible();
  await page.evaluate(() =>
    window.demo.first.tree(window.demo.checkout, {
      expanded: [],
      selected: ['src', 'src/nested', 'README.md'],
      focus: 'src',
    }),
  );
  await expect(row(page, 'src/nested')).toHaveCount(0);
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'Mention in Chat').click();
  expect(await page.evaluate(() => window.demo.mentioned)).toEqual([['README.md']]);
});
