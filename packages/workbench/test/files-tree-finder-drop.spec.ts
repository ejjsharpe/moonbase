import { test, expect, type Locator, type Page } from '@playwright/test';

declare global {
  interface Window {
    /** The names of each drop's files the app was asked to approve. */
    approved: string[][];
    /** Each import the editor dispatched. */
    imported: Parameters<typeof window.demo.first.mutate>[0][];
    /** Whether each drop reaching the window had already been taken. */
    windowDrops: boolean[];
  }
}

const region = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
const tree = (page: Page) => region(page).getByRole('tree', { name: 'Files', exact: true });
/** A row by path, whatever Git or unsaved state its name adds. */
const row = (page: Page, path: string) =>
  tree(page).getByRole('treeitem', {
    name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`),
  });
const treeState = (page: Page) =>
  page.evaluate(() => {
    const { tree } =
      window.demo.first.getSnapshot().recovery.views[window.demo.checkout.checkoutId];
    return { focus: tree.focus, selected: tree.selected, expanded: tree.expanded };
  });
const dropTargets = (page: Page) =>
  tree(page)
    .locator('[role="treeitem"][data-drop-target]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')!.split(',')[0]));
const read = (page: Page, path: string) =>
  page.evaluate(
    async (path) =>
      (await window.demo.client.command('readFile', { checkout: window.demo.checkout, path })).text,
    path,
  );
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

/**
 * Approves each dropped file as `ref:<name>`, and imports a reference as a file holding
 * `imported`, replacing only what the import names, as the workspace does.
 */
async function setup(page: Page) {
  await page.goto('/');
  await expect(row(page, 'welcome.ts')).toBeVisible();
  await page.evaluate(() => {
    window.approved = [];
    window.imported = [];
    window.windowDrops = [];
    window.addEventListener('drop', (event) => window.windowDrops.push(event.defaultPrevented));
    window.demo.selectDroppedImports = async (_checkout, files) => {
      window.approved.push(files.map((file) => file.name));
      return files.map((file) => `ref:${file.name}`);
    };
    const { first } = window.demo,
      mutate = first.mutate.bind(first);
    first.mutate = async (input) => {
      if (input.kind !== 'import') return mutate(input);
      window.imported.push(structuredClone(input));
      const names = input.nativeReferences!.map((reference) => reference.slice('ref:'.length));
      const destinations =
        names.length > 1
          ? names.map((name) => [input.destination, name].filter(Boolean).join('/'))
          : [input.destination!];
      for (const destination of destinations)
        await mutate({
          checkout: input.checkout,
          kind: 'create-file',
          sources: [],
          destination,
          text: 'imported',
          replacements: (input.replacements ?? []).filter(
            (item) => item.target.path.toLowerCase() === destination.toLowerCase(),
          ),
        });
      return {
        ...input,
        id: input.id!,
        clientId: first.clientId,
        recoveryChanges: [],
        outcome: 'completed',
        items: destinations.map((destination, index) => ({
          source: names[index],
          destination,
          outcome: 'completed' as const,
        })),
      };
    };
  });
}

/**
 * Drags OS files named `names` over `target`, as Finder does. Chromium ignores a script's
 * `dropEffect` outside a real drag, so the highlight shows whether the tree takes it.
 */
async function dragFiles(page: Page, target: Locator, names: string[], position = { x: 20, y: 6 }) {
  const dataTransfer = await page.evaluateHandle((names) => {
    const data = new DataTransfer();
    for (const name of names) data.items.add(new File(['x'], name));
    return data;
  }, names);
  const box = (await target.boundingBox())!;
  const at = { clientX: box.x + position.x, clientY: box.y + position.y };
  await target.dispatchEvent('dragenter', { dataTransfer, ...at });
  await target.dispatchEvent('dragover', { dataTransfer, ...at });
  return {
    drop: () => target.dispatchEvent('drop', { dataTransfer, ...at }),
  };
}
async function dropFiles(
  page: Page,
  target: Locator,
  names: string[],
  position?: { x: number; y: number },
) {
  await (await dragFiles(page, target, names, position)).drop();
}
const emptyArea = async (page: Page) => {
  const box = (await tree(page).boundingBox())!;
  return { x: 40, y: box.height - 20 };
};

test('files dropped from Finder on a folder import there without a dialog, and are selected', async ({
  page,
}) => {
  await setup(page);
  await create(page, 'dest/', 'dest/inner.ts');
  // A move to undo, which the import forgets.
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const name = tree(page).getByRole('textbox', { name: 'Rename', exact: true });
  await name.fill('NOTES.md');
  await name.press('Enter');
  await expect(row(page, 'NOTES.md')).toBeVisible();
  const drag = await dragFiles(page, row(page, 'dest'), ['a.txt']);
  await expect.poll(() => dropTargets(page)).toEqual(['dest']);
  // Hovering a collapsed folder for a moment expands it.
  await expect(row(page, 'dest/inner.ts')).toBeVisible();
  await expect.poll(() => dropTargets(page)).toEqual(['dest', 'dest/inner.ts']);
  await page.screenshot({ path: 'test-results/tree-finder-drop-region.png' });
  await drag.drop();
  await expect(row(page, 'dest/a.txt')).toBeVisible();
  expect(await page.evaluate(() => window.approved)).toEqual([['a.txt']]);
  expect(await page.evaluate(() => window.imported)).toMatchObject([
    {
      kind: 'import',
      checkout: { checkoutId: 'sample' },
      sources: [],
      destination: 'dest/a.txt',
      nativeReferences: ['ref:a.txt'],
      replacements: [],
    },
  ]);
  expect(await read(page, 'dest/a.txt')).toBe('imported');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await dropTargets(page)).toEqual([]);
  await expect
    .poll(() => treeState(page))
    .toMatchObject({ focus: 'dest/a.txt', selected: ['dest/a.txt'] });
  await expect(tree(page)).toBeFocused();
  // The window sees the drop already taken, so an app importing window-wide drops skips it.
  expect(await page.evaluate(() => window.windowDrops)).toEqual([true]);
  await region(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Undo Move' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('a Finder drop on a file row imports into its folder, and one on the empty area into the root', async ({
  page,
}) => {
  await setup(page);
  await row(page, 'src').click();
  await expect(row(page, 'src/example.ts')).toBeVisible();
  const drag = await dragFiles(page, row(page, 'src/example.ts'), ['a.txt', 'b.txt']);
  await expect.poll(() => dropTargets(page)).toEqual(['src', 'src/example.ts', 'src/ignored.ts']);
  await drag.drop();
  await expect(row(page, 'src/b.txt')).toBeVisible();
  expect((await page.evaluate(() => window.imported))[0]).toMatchObject({
    destination: 'src',
    nativeReferences: ['ref:a.txt', 'ref:b.txt'],
    replacements: [],
  });
  await expect
    .poll(() => treeState(page))
    .toMatchObject({ focus: 'src/a.txt', selected: ['src/a.txt', 'src/b.txt'] });
  const root = await dragFiles(page, tree(page), ['c.txt'], await emptyArea(page));
  await expect(tree(page)).toHaveAttribute('data-drop-target', 'true');
  expect(await dropTargets(page)).toEqual([]);
  await root.drop();
  await expect(row(page, 'c.txt')).toBeVisible();
  await expect(tree(page)).not.toHaveAttribute('data-drop-target');
  expect((await page.evaluate(() => window.imported))[1]).toMatchObject({ destination: 'c.txt' });
  await expect.poll(() => treeState(page)).toMatchObject({ selected: ['c.txt'] });
});

test('a Finder drop onto existing names asks before replacing them', async ({ page }) => {
  await setup(page);
  const prompt = page.getByRole('dialog', { name: 'Replace README.md?', exact: true });
  // Several files import as one batch, which finds what their names land on.
  await dropFiles(page, tree(page), ['README.md', 'new.txt'], await emptyArea(page));
  await expect(prompt).toContainText('README.md already exists and will be replaced.');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => window.imported)).toEqual([]);
  expect(await read(page, 'README.md')).toContain('# Volatile demo');
  await dropFiles(page, tree(page), ['README.md', 'new.txt'], await emptyArea(page));
  await prompt.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(row(page, 'new.txt')).toBeVisible();
  const [call] = await page.evaluate(() => window.imported);
  expect(call).toMatchObject({
    destination: '',
    nativeReferences: ['ref:README.md', 'ref:new.txt'],
  });
  expect(call.replacements?.map((item) => item.target.path)).toEqual(['README.md']);
  expect(await read(page, 'README.md')).toBe('imported');
  // One file asks the same way.
  await row(page, 'src').click();
  await dropFiles(page, row(page, 'src'), ['example.ts']);
  const single = page.getByRole('dialog', { name: 'Replace example.ts?', exact: true });
  await expect(single).toContainText('src/example.ts already exists and will be replaced.');
  await single.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.imported.length)).toBe(1);
  expect(await read(page, 'src/example.ts')).toContain('double');
});

test('Finder drops are refused while a name is typed or a dialog is open', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const name = tree(page).getByRole('textbox', { name: 'Rename', exact: true });
  await expect(name).toBeFocused();
  const drag = await dragFiles(page, row(page, 'src'), ['a.txt']);
  expect(await dropTargets(page)).toEqual([]);
  await drag.drop();
  await expect(region(page).getByRole('alert')).toContainText(
    'Finish naming the entry before importing files.',
  );
  await name.press('Escape');
  await row(page, 'welcome.ts').click();
  const area = await emptyArea(page);
  await tree(page).press('ControlOrMeta+Backspace');
  const trash = page.getByRole('dialog', { name: 'Move to Trash', exact: true });
  await expect(trash).toBeVisible();
  // The dialog hides the tree from the accessibility tree, but a drop can still reach it.
  await dropFiles(
    page,
    page.locator('section[aria-label="First editor"] [role="tree"]'),
    ['b.txt'],
    area,
  );
  await trash.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trash).toHaveCount(0);
  expect(await page.evaluate(() => window.approved)).toEqual([]);
  expect(await page.evaluate(() => window.imported)).toEqual([]);
  // Both drops were the tree's, so the app doesn't import them at the root instead.
  expect(await page.evaluate(() => window.windowDrops)).toEqual([true, true]);
});

test('a checkout closed while a Finder drop is approved imports nothing', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    let release!: (references: string[]) => void;
    window.demo.selectDroppedImports = () =>
      new Promise<string[]>((resolve) => {
        release = resolve;
      });
    Object.assign(window, { finishApproval: () => release(['ref:late.txt']) });
  });
  await dropFiles(page, row(page, 'src'), ['late.txt']);
  await page.evaluate(async () => {
    await window.demo.first.closeCheckout(window.demo.checkout);
    (window as unknown as { finishApproval(): void }).finishApproval();
  });
  await expect(region(page).getByRole('alert')).toContainText(
    'Open the exact import checkout before importing files.',
  );
  expect(await page.evaluate(() => window.imported)).toEqual([]);
});
