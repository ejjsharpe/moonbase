import { test, expect, type Locator, type Page } from '@playwright/test';
import type { OperationResult, WorkspaceOperation } from '@moonbase/contracts/workspace';

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
const dropTargets = (page: Page) =>
  tree(page)
    .locator('[role="treeitem"][data-drop-target]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')!.split(',')[0]));
/**
 * Lets the work a key or drop started finish before checking that it changed nothing: the demo
 * workspace answers without timers, so it is done once the page's pending tasks and frames have run.
 */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))),
      ),
  );
/** Presses on `source` and drags over `target` without dropping. */
async function dragOver(
  page: Page,
  source: Locator,
  target: Locator,
  position?: { x: number; y: number },
) {
  await source.hover();
  await page.mouse.down();
  // Chromium starts the drag on the first move and fires dragover on the next.
  await target.hover({ position });
  await target.hover({ position });
}
/**
 * Makes the workspace fail `path`'s item in any batch move that includes it, as a batch failing
 * partway does, while still moving the rest. Resolves to a function that stops it.
 */
async function failInBatches(page: Page, path: string) {
  await page.evaluate((path) => {
    const { client } = window.demo;
    const command = client.command;
    const join = (folder: string | undefined, name: string) =>
      [folder, name].filter(Boolean).join('/');
    const nameOf = (path: string) => path.split('/').at(-1)!;
    client.command = (async (name: string, input: unknown, options: unknown) => {
      const operation = input as WorkspaceOperation;
      const call = command as (name: string, input: unknown, options: unknown) => Promise<unknown>;
      if (
        name !== 'mutate' ||
        operation.sources.length < 2 ||
        !operation.sources.some((source) => source.target.path === path)
      )
        return call.call(client, name, input, options);
      const rest = operation.sources.filter((source) => source.target.path !== path);
      const result = (await call.call(
        client,
        name,
        {
          ...operation,
          sources: rest,
          destination:
            rest.length > 1
              ? operation.destination
              : join(operation.destination, nameOf(rest[0].target.path)),
        },
        options,
      )) as OperationResult;
      return {
        ...result,
        outcome: 'failed',
        message: `Couldn’t move ${path}.`,
        items: [
          ...result.items,
          {
            source: path,
            destination: join(operation.destination, nameOf(path)),
            outcome: 'failed',
          },
        ],
      } satisfies OperationResult;
    }) as typeof command;
    Object.assign(window, {
      stopFailing: () => {
        client.command = command;
      },
    });
  }, path);
  return () => page.evaluate(() => (window as unknown as { stopFailing(): void }).stopFailing());
}
async function explorerMenu(page: Page) {
  await region(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  return page.getByRole('menu', { name: 'Explorer actions', exact: true });
}
async function expectSelected(page: Page, paths: string[]) {
  await expect.poll(() => treeState(page)).toEqual({ focus: paths[0], selected: paths });
  await expect(tree(page)).toBeFocused();
  await expect(tree(page)).toHaveAttribute(
    'aria-activedescendant',
    (await row(page, paths[0]).getAttribute('id'))!,
  );
}

test('dragging a file onto a folder moves it there, highlighting the folder and what it shows', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'src').click();
  await expect(row(page, 'src/example.ts')).toBeVisible();
  await dragOver(page, row(page, 'welcome.ts'), row(page, 'src/example.ts'));
  await expect.poll(() => dropTargets(page)).toEqual(['src', 'src/example.ts', 'src/ignored.ts']);
  await row(page, 'dest').hover();
  await row(page, 'dest').hover();
  await expect.poll(() => dropTargets(page)).toEqual(['dest']);
  await page.mouse.up();
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toHaveCount(0);
  await expect(row(page, 'dest')).toHaveAttribute('aria-expanded', 'true');
  await expectSelected(page, ['dest/welcome.ts']);
  expect(await dropTargets(page)).toEqual([]);
  expect(await read(page, 'dest/welcome.ts')).toContain('Moonbase editor module demo');
  // The open file follows.
  await expect(
    region(page).getByRole('tab', { name: 'dest/welcome.ts', exact: true }),
  ).toBeVisible();
});

test('dragging a selected row drags the whole selection as one batch', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'README.md').click();
  await row(page, 'welcome.ts').click({ modifiers: ['ControlOrMeta'] });
  const before = await mutations(page);
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/README.md')).toBeVisible();
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  expect(await mutations(page)).toBe(before + 1);
  await expectSelected(page, ['dest/README.md', 'dest/welcome.ts']);
  // An unselected row drags alone, and a batch can go back to the root.
  await row(page, 'ignored.txt').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/ignored.txt')).toBeVisible();
  expect(await exists(page, 'dest/README.md')).toBe(true);
  await row(page, 'dest/README.md').click();
  await row(page, 'dest/ignored.txt').click({ modifiers: ['ControlOrMeta'] });
  const box = (await tree(page).boundingBox())!;
  await row(page, 'dest/ignored.txt').dragTo(tree(page), {
    targetPosition: { x: 40, y: box.height - 20 },
  });
  await expect(row(page, 'README.md')).toBeVisible();
  await expect(row(page, 'ignored.txt')).toBeVisible();
  await expectSelected(page, ['README.md', 'ignored.txt']);
});

test('a drop on a file row lands in its folder, and one on the empty area in the root', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'src').click();
  await row(page, 'README.md').dragTo(row(page, 'src/example.ts'));
  await expect(row(page, 'src/README.md')).toBeVisible();
  expect(await exists(page, 'README.md')).toBe(false);
  const box = (await tree(page).boundingBox())!;
  await dragOver(page, row(page, 'src/example.ts'), tree(page), { x: 40, y: box.height - 20 });
  await expect(tree(page)).toHaveAttribute('data-drop-target', 'true');
  expect(await dropTargets(page)).toEqual([]);
  await page.mouse.up();
  await expect(row(page, 'example.ts')).toBeVisible();
  await expect(tree(page)).not.toHaveAttribute('data-drop-target');
  expect(await exists(page, 'src/example.ts')).toBe(false);
  await expectSelected(page, ['example.ts']);
});

test('drops into a dragged folder or where nothing would move are refused', async ({ page }) => {
  await page.goto('/');
  await row(page, 'src').click();
  const before = await mutations(page);
  // Into its own descendant, or onto itself.
  await dragOver(page, row(page, 'src'), row(page, 'src/example.ts'));
  await expect.poll(() => dropTargets(page)).toEqual([]);
  await row(page, 'src').hover();
  await row(page, 'src').hover();
  expect(await dropTargets(page)).toEqual([]);
  await page.mouse.up();
  // Already in that folder.
  await dragOver(page, row(page, 'README.md'), row(page, 'welcome.ts'));
  await expect(tree(page)).not.toHaveAttribute('data-drop-target');
  await page.mouse.up();
  await row(page, 'src/example.ts').dragTo(row(page, 'src/ignored.ts'));
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'src/example.ts')).toBe(true);
  expect(await exists(page, 'README.md')).toBe(true);
  // Rows from the other editor's tree are another editor's drag.
  const second = page
    .getByRole('region', { name: 'Second editor', exact: true })
    .getByRole('treeitem', { name: /^README\.md(,|$)/ });
  await second.dragTo(row(page, 'src'));
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'README.md')).toBe(true);
});

test('hovering a collapsed folder while dragging expands it', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await create(page, 'dest/', 'dest/inner/');
  await expect(row(page, 'dest')).toHaveAttribute('aria-expanded', 'false');
  await dragOver(page, row(page, 'README.md'), row(page, 'dest'));
  await expect(row(page, 'dest')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'dest/inner')).toBeVisible();
  await row(page, 'dest/inner').hover();
  await row(page, 'dest/inner').hover();
  await expect.poll(() => dropTargets(page)).toEqual(['dest/inner']);
  await page.mouse.up();
  await expect(row(page, 'dest/inner/README.md')).toBeVisible();
  // Leaving before the moment passes expands nothing.
  await create(page, 'later/');
  await dragOver(page, row(page, 'welcome.ts'), row(page, 'later'));
  await row(page, 'welcome.ts').hover();
  await page.clock.runFor(700);
  await page.mouse.up();
  await expect(row(page, 'later')).toHaveAttribute('aria-expanded', 'false');
});

test('holding Alt copies instead of moving, which there is no undoing', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  // The drop effect the tree chose, read after its handlers.
  await page.evaluate(() =>
    window.addEventListener('dragover', (event) => {
      document.body.dataset.dropEffect = event.dataTransfer!.dropEffect;
    }),
  );
  await dragOver(page, row(page, 'welcome.ts'), row(page, 'dest'));
  await expect(page.locator('body')).toHaveAttribute('data-drop-effect', 'move');
  await page.keyboard.down('Alt');
  const box = (await row(page, 'dest').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator('body')).toHaveAttribute('data-drop-effect', 'copy');
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await read(page, 'dest/welcome.ts')).toBe(await read(page, 'welcome.ts'));
  const menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('a move onto an existing name asks before replacing it', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/', 'dest/README.md');
  await row(page, 'README.md').dragTo(row(page, 'dest'));
  const prompt = page.getByRole('dialog', { name: 'Replace README.md?', exact: true });
  await expect(prompt).toContainText('dest/README.md already exists and will be replaced.');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  expect(await exists(page, 'README.md')).toBe(true);
  await row(page, 'README.md').dragTo(row(page, 'dest'));
  await prompt.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(row(page, 'README.md')).toHaveCount(0);
  expect(await read(page, 'dest/README.md')).toContain('# Volatile demo');
  await expectSelected(page, ['dest/README.md']);
});

test('⌘Z in the tree undoes a move, and the … menu names what it undoes', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'README.md').click();
  await row(page, 'welcome.ts').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  let menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move of 2 Items' })).not.toHaveAttribute(
    'aria-disabled',
  );
  await page.keyboard.press('Escape');
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'README.md')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
  await expectSelected(page, ['README.md', 'welcome.ts']);
  // Nothing is left to undo.
  menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  // A single move undone from the menu.
  await row(page, 'welcome.ts').click();
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  menu = await explorerMenu(page);
  await menu.getByRole('menuitem', { name: 'Undo Move', exact: true }).click();
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
});

test('⌘Z undoes an inline rename, but not while the name is typed', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = tree(page).getByRole('textbox', { name: 'Rename', exact: true });
  await input.pressSequentially('NOTES');
  await input.press('Enter');
  await expect(row(page, 'NOTES.md')).toBeVisible();
  const menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Rename', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // In the name field, ⌘Z is the field's own: it brings back the cleared name, and the rename
  // stays, even once an undo would have had time to run.
  await tree(page).press('F2');
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await expect(input).toHaveValue('');
  const before = await mutations(page);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('NOTES.md');
  await settle(page);
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'NOTES.md')).toBe(true);
  expect(await exists(page, 'README.md')).toBe(false);
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await tree(page).press('ControlOrMeta+z');
  await expect.poll(() => exists(page, 'README.md')).toBe(true);
  expect(await mutations(page)).toBe(before + 1);
  await expect(row(page, 'README.md')).toBeVisible();
  await expect(row(page, 'NOTES.md')).toHaveCount(0);
  await expectSelected(page, ['README.md']);
});

test('undo is refused, and forgotten, once the original path is taken', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await create(page, 'welcome.ts');
  await expect(row(page, 'welcome.ts')).toBeVisible();
  const before = await mutations(page);
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(region(page).getByRole('alert')).toContainText(
    'Can’t undo the move: welcome.ts is taken.',
  );
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'dest/welcome.ts')).toBe(true);
  const menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('unsaved text follows a move and its undo', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.edit({ checkout, path: 'welcome.ts' }, 'Unsaved draft\n');
  });
  await expect(row(page, 'welcome.ts')).toHaveAttribute('aria-label', /unsaved/);
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toHaveAttribute('aria-label', /unsaved/);
  const buffer = (path: string) =>
    page.evaluate(
      (path) => window.demo.first.buffer({ checkout: window.demo.checkout, path })?.text,
      path,
    );
  expect(await buffer('dest/welcome.ts')).toBe('Unsaved draft\n');
  expect(await buffer('welcome.ts')).toBeUndefined();
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'welcome.ts')).toHaveAttribute('aria-label', /unsaved/);
  expect(await buffer('welcome.ts')).toBe('Unsaved draft\n');
  expect(await buffer('dest/welcome.ts')).toBeUndefined();
  expect(await read(page, 'welcome.ts')).toContain('Moonbase editor module demo');
});

/** Renames the row at `path` to `name` in the tree. */
async function rename(page: Page, path: string, name: string) {
  await row(page, path).click();
  await tree(page).press('F2');
  const input = tree(page).getByRole('textbox', { name: 'Rename', exact: true });
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}
async function expectNoUndo(page: Page) {
  const menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
}

test('any other file operation forgets the undo, so ⌘Z never reaches past it', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  // An Alt-copy after a rename.
  await rename(page, 'README.md', 'NOTES.md');
  await expect(row(page, 'NOTES.md')).toBeVisible();
  await dragOver(page, row(page, 'welcome.ts'), row(page, 'dest'));
  await page.keyboard.down('Alt');
  const box = (await row(page, 'dest').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await expectNoUndo(page);
  let before = await mutations(page);
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await settle(page);
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'NOTES.md')).toBe(true);
  // Move to Trash, from its dialog, after a rename.
  await rename(page, 'NOTES.md', 'README.md');
  await row(page, 'dest/welcome.ts').click();
  await tree(page).press('ControlOrMeta+Backspace');
  const trash = page.getByRole('dialog', { name: 'Move to Trash', exact: true });
  await trash.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(trash).toHaveCount(0);
  await expect(row(page, 'dest/welcome.ts')).toHaveCount(0);
  await expectNoUndo(page);
  before = await mutations(page);
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await settle(page);
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'README.md')).toBe(true);
  // A trash cancelled in its dialog changes nothing, and keeps the undo.
  await rename(page, 'README.md', 'NOTES.md');
  await row(page, 'welcome.ts').click();
  await tree(page).press('ControlOrMeta+Backspace');
  await trash.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'README.md')).toBeVisible();
  expect(await exists(page, 'NOTES.md')).toBe(false);
});

test('a batch that fails partway selects and undoes what moved, and so does its undo', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'README.md').click();
  await row(page, 'welcome.ts').click({ modifiers: ['ControlOrMeta'] });
  let stop = await failInBatches(page, 'welcome.ts');
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(region(page).getByRole('alert')).toContainText('Couldn’t move welcome.ts.');
  await expect(row(page, 'dest/README.md')).toBeVisible();
  expect(await exists(page, 'welcome.ts')).toBe(true);
  await expectSelected(page, ['dest/README.md']);
  await stop();
  let menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move', exact: true })).not.toHaveAttribute(
    'aria-disabled',
  );
  await page.keyboard.press('Escape');
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'README.md')).toBeVisible();
  expect(await exists(page, 'dest/README.md')).toBe(false);
  // An undo that fails partway keeps exactly what is left.
  await row(page, 'README.md').click();
  await row(page, 'welcome.ts').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  stop = await failInBatches(page, 'dest/welcome.ts');
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'README.md')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(true);
  await stop();
  menu = await explorerMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Undo Move', exact: true })).not.toHaveAttribute(
    'aria-disabled',
  );
  await page.keyboard.press('Escape');
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
  await expectNoUndo(page);
});

test('an undo whose folders can’t be listed reports it and stays to retry', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  await row(page, 'welcome.ts').dragTo(row(page, 'dest'));
  await expect(row(page, 'dest/welcome.ts')).toBeVisible();
  await page.evaluate(() => {
    const { client } = window.demo;
    const command = client.command;
    client.command = ((...args: Parameters<typeof command>) =>
      args[0] === 'listDirectory'
        ? Promise.reject(new Error('Listing unavailable.'))
        : command.apply(client, args)) as typeof command;
    Object.assign(window, {
      stopFailing: () => {
        client.command = command;
      },
    });
  });
  const before = await mutations(page);
  await tree(page).focus();
  await tree(page).press('ControlOrMeta+z');
  await expect(region(page).getByRole('alert')).toContainText(
    'Can’t undo the move yet: dest couldn’t be listed. Try again.',
  );
  expect(await mutations(page)).toBe(before);
  await page.evaluate(() => (window as unknown as { stopFailing(): void }).stopFailing());
  await tree(page).press('ControlOrMeta+z');
  await expect(row(page, 'welcome.ts')).toBeVisible();
  expect(await exists(page, 'dest/welcome.ts')).toBe(false);
});

test('a drop whose DataTransfer isn’t the tree’s own drag is refused', async ({ page }) => {
  await page.goto('/');
  await create(page, 'dest/');
  const before = await mutations(page);
  await dragOver(page, row(page, 'welcome.ts'), row(page, 'dest'));
  await expect.poll(() => dropTargets(page)).toEqual(['dest']);
  // Another page's drop naming other entries, while this tree's drag goes on.
  await row(page, 'dest').evaluate((target) => {
    const data = new DataTransfer();
    data.setData(
      'application/x-moonbase-entries',
      JSON.stringify({ source: 'elsewhere', checkout: 'elsewhere', paths: ['README.md'] }),
    );
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  });
  await page.mouse.up();
  await settle(page);
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'README.md')).toBe(true);
  expect(await exists(page, 'welcome.ts')).toBe(true);
});

test('dragging more entries than one move takes says so', async ({ page }) => {
  await page.goto('/');
  const paths = Array.from({ length: 129 }, (_, index) => `many/${index}.ts`);
  await create(page, 'many/', ...paths);
  await row(page, 'many').click();
  await expect(row(page, 'many/0.ts')).toBeVisible();
  await page.evaluate((paths) => {
    const { first, checkout } = window.demo;
    first.tree(checkout, { focus: paths[0], selected: paths });
  }, paths);
  const before = await mutations(page);
  await row(page, 'many/0.ts').dragTo(tree(page));
  await expect(region(page).getByRole('alert')).toContainText('Drag at most 128 items at a time.');
  expect(await mutations(page)).toBe(before);
});
