import { test, expect, type Page } from '@playwright/test';

// `?clipboard` lets ⌘V reach the workbench, which asks the demo's faux OS clipboard (no files
// unless a test says so) first, so no press falls through to the real one.
const region = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
const tree = (page: Page) => region(page).getByRole('tree', { name: 'Files', exact: true });
/** A row by path, whatever Git, unsaved or cut state its name adds. */
const row = (page: Page, path: string) =>
  tree(page).getByRole('treeitem', {
    name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`),
  });
const menu = (page: Page) => page.getByRole('menu', { name: 'File actions', exact: true });
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });
const treeState = (page: Page) =>
  page.evaluate(() => {
    const { tree } =
      window.demo.first.getSnapshot().recovery.views[window.demo.checkout.checkoutId];
    return { focus: tree.focus, selected: tree.selected };
  });
const mutations = (page: Page) => page.evaluate(() => window.demo.memory.stats.mutations);
const read = (page: Page, path: string) =>
  page.evaluate(
    async (path) =>
      (await window.demo.client.command('readFile', { checkout: window.demo.checkout, path })).text,
    path,
  );
const exists = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const { client, checkout } = window.demo;
    const parent = path.split('/').slice(0, -1).join('/');
    const listing = await client.command('listDirectory', { checkout, path: parent });
    return listing.entries.some((entry) => entry.path === path);
  }, path);
/** Creates entries directly in the first editor: folders end with a slash. */
const create = (page: Page, ...paths: string[]) =>
  page.evaluate(async (paths) => {
    const { first, checkout } = window.demo;
    for (const path of paths)
      await first.mutate({
        checkout,
        kind: path.endsWith('/') ? 'create-directory' : 'create-file',
        sources: [],
        destination: path.replace(/\/$/, ''),
        replacements: [],
      });
  }, paths);
/** The rows shown as cut. */
const cutRows = (page: Page) =>
  tree(page)
    .locator('[role="treeitem"]')
    .evaluateAll((rows) =>
      rows
        .map((row) => row.getAttribute('aria-label')!)
        .filter((label) => label.split(', ').includes('cut'))
        .map((label) => label.split(',')[0]),
    );
async function expectSelected(page: Page, paths: string[]) {
  await expect.poll(() => treeState(page)).toEqual({ focus: paths[0], selected: paths });
  await expect(tree(page)).toBeFocused();
}
/** Opens the "…" menu and checks that nothing can be undone. */
async function expectNoUndo(page: Page) {
  await region(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  await expect(
    page
      .getByRole('menu', { name: 'Explorer actions', exact: true })
      .getByRole('menuitem', { name: 'Undo Move' }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
}

test('copy and paste into a folder copies the entry and writes its path as text', async ({
  page,
}) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/');
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+c');
  expect(await page.evaluate(() => window.demo.copied)).toEqual(['welcome.ts']);
  // Copied entries aren't dimmed.
  expect(await cutRows(page)).toEqual([]);
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toBeVisible();
  await expectSelected(page, ['dest/welcome.ts']);
  expect(await read(page, 'dest/welcome.ts')).toBe(await read(page, 'welcome.ts'));
  // A copy has no undoing.
  await expectNoUndo(page);
});

test('pasting into the same folder picks the next free copy name', async ({ page }) => {
  await page.goto('/?clipboard');
  await row(page, 'README.md').click();
  await tree(page).press('ControlOrMeta+c');
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'README copy.md')).toBeVisible();
  await expectSelected(page, ['README copy.md']);
  // Focus is now on the copy, in the same folder.
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'README copy 2.md')).toBeVisible();
  await expectSelected(page, ['README copy 2.md']);
  expect(await read(page, 'README copy 2.md')).toBe(await read(page, 'README.md'));
  // A copied folder pasted onto itself lands beside it.
  await row(page, 'src').click();
  await tree(page).press('ControlOrMeta+c');
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'src copy')).toBeVisible();
  expect(await exists(page, 'src copy/example.ts')).toBe(true);
});

test('a multi-item copy with a partial collision copies the rest under their names', async ({
  page,
}) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/', 'dest/README.md');
  await row(page, 'README.md').click();
  await row(page, 'welcome.ts').click({ modifiers: ['ControlOrMeta'] });
  await tree(page).press('ControlOrMeta+c');
  expect(await page.evaluate(() => window.demo.copied)).toEqual(['README.md\nwelcome.ts']);
  await row(page, 'dest').click();
  const before = await mutations(page);
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'dest/README copy.md')).toBeVisible();
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expectSelected(page, ['dest/welcome.ts', 'dest/README copy.md']);
  // Nothing was replaced, and nothing asked to.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await read(page, 'dest/README.md')).toBe('');
  expect(await read(page, 'dest/README copy.md')).toContain('# Volatile demo');
  expect(await mutations(page)).toBe(before + 2);
});

test('cut and paste moves, dimming while pending; Escape clears it and ⌘Z undoes the move', async ({
  page,
}) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/');
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+x');
  await expect.poll(() => cutRows(page)).toEqual(['welcome.ts']);
  expect(
    await row(page, 'welcome.ts').evaluate((element) => Number(getComputedStyle(element).opacity)),
  ).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/tree-cut.png' });
  await tree(page).press('Escape');
  await expect.poll(() => cutRows(page)).toEqual([]);
  // A cleared cut pastes nothing.
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  expect(await mutations(page)).toBe(1);
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+x');
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toHaveCount(0);
  await expectSelected(page, ['dest/welcome.ts']);
  expect(await cutRows(page)).toEqual([]);
  // The cut is used up.
  const moved = await mutations(page);
  await tree(page).press('ControlOrMeta+v');
  expect(await mutations(page)).toBe(moved);
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
  await expectSelected(page, ['welcome.ts']);
});

test('a cut folder can’t be pasted into itself, and a cut onto its own folder does nothing', async ({
  page,
}) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/', 'dest/inner/');
  await row(page, 'dest').click();
  await expect(row(page, 'dest/inner')).toBeVisible();
  await tree(page).press('ControlOrMeta+x');
  await expect.poll(() => cutRows(page)).toEqual(['dest', 'dest/inner']);
  await row(page, 'dest/inner').click();
  await tree(page).press('ControlOrMeta+v');
  await expect(region(page).getByRole('alert')).toContainText('Can’t move a folder into itself.');
  await row(page, 'dest').click({ button: 'right' });
  await expect(item(page, 'Paste')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await row(page, 'dest/inner').click({ button: 'right' });
  await expect(item(page, 'Paste')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  expect(await mutations(page)).toBe(2);
  expect(await cutRows(page)).toEqual(['dest', 'dest/inner']);
});

test('files copied in the OS since win over the tree’s clipboard', async ({ page }) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/');
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+c');
  await page.evaluate(() => {
    window.demo.selectClipboardImports = async () => ['native-reference'];
  });
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  const importing = page.getByRole('dialog', { name: 'Import files', exact: true });
  await expect(importing).toBeVisible();
  await importing.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
  // Without OS files, the tree's own entries paste.
  await page.evaluate(() => {
    window.demo.selectClipboardImports = async () => [];
  });
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
});

test('⌘C in the name field copies text, not files', async ({ page }) => {
  await page.goto('/?clipboard');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = tree(page).getByRole('textbox', { name: 'Rename', exact: true });
  // A synthetic press: the field's own copy would write the real OS clipboard.
  for (const code of ['KeyC', 'KeyX'])
    expect(
      await input.evaluate(
        (element, code) =>
          element.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: code.at(-1)!.toLowerCase(),
              code,
              metaKey: navigator.platform.includes('Mac'),
              ctrlKey: !navigator.platform.includes('Mac'),
              bubbles: true,
              cancelable: true,
            }),
          ),
        code,
      ),
    ).toBe(true);
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(tree(page)).toBeFocused();
  expect(await page.evaluate(() => window.demo.copied)).toEqual([]);
  expect(await cutRows(page)).toEqual([]);
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'README copy.md')).toHaveCount(0);
  expect(await mutations(page)).toBe(0);
});

test('the menu cuts, copies and pastes, enabling Paste only with something to paste', async ({
  page,
}) => {
  await page.goto('/?clipboard');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await row(page, 'README.md').click({ button: 'right' });
  await expect(item(page, 'Cut')).toHaveAttribute('aria-keyshortcuts', `${mod}+X`);
  await expect(item(page, 'Copy')).toHaveAttribute('aria-keyshortcuts', `${mod}+C`);
  await expect(item(page, 'Paste')).toHaveAttribute('aria-keyshortcuts', `${mod}+V`);
  await expect(item(page, 'Paste')).toHaveAttribute('aria-disabled', 'true');
  await item(page, 'Copy').click();
  await expect(tree(page)).toBeFocused();
  // On a file row, Paste goes into the file's folder.
  await row(page, 'src').click();
  await row(page, 'src/example.ts').click({ button: 'right' });
  await expect(item(page, 'Paste')).not.toHaveAttribute('aria-disabled');
  await item(page, 'Paste').click();
  await expect(row(page, 'src/README.md')).toBeVisible();
  await expectSelected(page, ['src/README.md']);
  await row(page, 'welcome.ts').click({ button: 'right' });
  await item(page, 'Cut').click();
  await expect.poll(() => cutRows(page)).toEqual(['welcome.ts']);
  // Where the cut already is, there's nothing to paste.
  await row(page, 'README.md').click({ button: 'right' });
  await expect(item(page, 'Paste')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'Paste').click();
  await expect(row(page, 'src/welcome.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toHaveCount(0);
});

test('a cut entry that has gone reports it and clears the clipboard', async ({ page }) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/', 'gone.ts');
  await row(page, 'gone.ts').click();
  await tree(page).press('ControlOrMeta+x');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    const sources = await first.inspect(checkout, ['gone.ts']);
    await first.mutate({ checkout, kind: 'trash', sources, replacements: [] });
  });
  await expect(row(page, 'gone.ts')).toHaveCount(0);
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  await expect(region(page).getByRole('alert')).toContainText(
    'Can’t paste: gone.ts no longer exists.',
  );
  await row(page, 'dest').click({ button: 'right' });
  await expect(item(page, 'Paste')).toHaveAttribute('aria-disabled', 'true');
});

test('unsaved text survives a cut and paste', async ({ page }) => {
  await page.goto('/?clipboard');
  await create(page, 'dest/');
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.edit({ checkout, path: 'welcome.ts' }, 'Unsaved draft\n');
  });
  await expect(row(page, 'welcome.ts')).toHaveAttribute('aria-label', /unsaved/);
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+x');
  await expect(row(page, 'welcome.ts')).toHaveAttribute('aria-label', /^welcome\.ts, unsaved, cut/);
  await row(page, 'dest').click();
  await tree(page).press('ControlOrMeta+v');
  await expect(row(page, 'dest/welcome.ts')).toHaveAttribute('aria-label', /unsaved/);
  expect(
    await page.evaluate(
      () =>
        window.demo.first.buffer({ checkout: window.demo.checkout, path: 'dest/welcome.ts' })?.text,
    ),
  ).toBe('Unsaved draft\n');
  expect(await read(page, 'dest/welcome.ts')).toContain('Moonbase editor module demo');
});
