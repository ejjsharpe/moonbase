import { test, expect, type Page } from '@playwright/test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';

declare global {
  interface Window {
    finishMenuOpening(): Promise<void>;
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
    await expect(item(page, 'Rename')).toBeFocused();
    const captured = await selected(page);
    await page.keyboard.press('End');
    await expect(item(page, 'Move to Trash')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item(page, 'Rename')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Copy')).toBeFocused();
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
  await expect(item(page, 'Rename')).toHaveAttribute('aria-disabled', 'true');
  await expect(item(page, 'Copy')).toHaveAttribute('aria-disabled', 'true');
  await expect(item(page, 'Move to Trash')).not.toHaveAttribute('aria-disabled', 'true');
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
  ['Rename', 'Rename'],
  ['Copy', 'Copy'],
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
    await expect(item(page, 'Rename')).toBeFocused();
    await page.keyboard.press(key);
    await expect(menu(page)).toHaveCount(0);
    await expect(
      key === 'Tab'
        ? region(page).getByRole('tab', { name: 'welcome.ts', exact: true })
        : region(page).getByRole('button', { name: 'Reveal Active File', exact: true }),
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

test('large-tree menus capture all offscreen paths and keep row virtualization', async ({
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
  await tree(page).focus();
  await tree(page).press('Home');
  await tree(page).press('Shift+End');
  await tree(page).press('ContextMenu');
  expect(await tree(page).getByRole('treeitem').count()).toBeLessThan(80);
  expect(await selected(page)).toHaveLength(10000);
  await item(page, 'Move to Trash').click();
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
  await item(page, 'Copy').click();
  const dialog = page.getByRole('dialog', { name: 'Copy', exact: true });
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
  await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
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
  await item(page, 'Copy').click();
  await expect(page.getByRole('dialog', { name: 'Copy', exact: true })).toContainText('README.md');
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
  await item(page, 'Copy').click();
  const dialog = page.getByRole('dialog', { name: 'Copy', exact: true });
  await expect(dialog).toContainText('remote-memory · /demo/remote');
  await dialog.getByLabel('Destination relative path', { exact: true }).fill('remote-copy.md');
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
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
  await page.keyboard.press('Meta+v');
  await menu(page).evaluate((element) =>
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true })),
  );
  await page.keyboard.press('c');
  await expect(item(page, 'Copy')).toBeFocused();
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
  await expect(item(page, 'Copy')).toHaveAttribute('aria-disabled', 'true');
  await item(page, 'Copy').dispatchEvent('click');
  await expect(page.getByRole('dialog', { name: 'Copy', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.recoveryRace.release());
  await expect
    .poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving))
    .toBe(false);
  await page.getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await expect(item(page, 'Copy')).toBeEnabled();
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
  await expect(item(page, 'Copy')).not.toHaveAttribute('aria-disabled', 'true');
  await item(page, 'Copy').click();
  await expect(page.getByRole('dialog', { name: 'Copy', exact: true })).toBeVisible();
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

test('another workbench preservation dialog dismisses the menu and owns the first click', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await page.evaluate(() => {
    const { second, checkout } = window.demo;
    second.edit({ checkout, path: 'welcome.ts' }, 'Other editor dirty text');
    void second.close([{ checkout, path: 'welcome.ts' }]);
  });
  const dialog = page.getByRole('dialog', { name: 'Save changes before closing?', exact: true });
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
    else await expect(item(page, 'Rename')).toBeFocused();
    await page.evaluate(() =>
      window.demo.first.tree(window.demo.checkout, {
        selected: ['welcome.ts'],
        focus: 'welcome.ts',
      }),
    );
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Copy')).toBeFocused();
    if (timing === 'late completion') {
      await page.evaluate(() => window.finishMenuOpening());
      await expect(item(page, 'Copy')).toBeFocused();
    }
    await page.keyboard.press('Space');
    if (timing === 'before completion') await page.evaluate(() => window.finishMenuOpening());
    const dialog = page.getByRole('dialog', { name: 'Copy', exact: true });
    await expect(dialog).toContainText('README.md');
    await dialog.getByLabel('Destination relative path', { exact: true }).fill('copied.md');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
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
  await item(page, 'Rename').click();
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
    await expect(item(page, 'Rename')).toBeFocused();
    await expect(item(page, 'Rename')).toHaveCSS('background-color', 'rgb(43, 43, 46)');
    await expect
      .poll(() =>
        menu(page).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= innerWidth - 260 &&
            rect.top >= innerHeight - 200 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.screenshot({ path: `test-results/file-menu-${width}.png` });
  });
