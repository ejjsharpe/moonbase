import { test, expect, type Locator, type Page } from '@playwright/test';

const region = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
const tree = (page: Page) => region(page).getByRole('tree', { name: 'Files', exact: true });
/** A row by path, whatever Git or unsaved state its name adds. */
const row = (page: Page, path: string) =>
  tree(page).getByRole('treeitem', {
    name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`),
  });
const menu = (page: Page) => page.getByRole('menu', { name: 'File actions', exact: true });
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });
const field = (page: Page, name: string) => tree(page).getByRole('textbox', { name, exact: true });
const selection = (input: Locator) =>
  input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]);
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
/** Holds the first editor's next mutation until `release()`. */
async function holdNextMutation(page: Page) {
  await page.evaluate(() => {
    const editor = window.demo.first,
      mutate = editor.mutate.bind(editor);
    delete document.body.dataset.mutationReply;
    editor.mutate = async (input) => {
      editor.mutate = mutate;
      await new Promise<void>((resolve) => {
        window.addEventListener('release-mutation', () => resolve(), { once: true });
        document.body.dataset.mutationReply = 'waiting';
      });
      return mutate(input);
    };
  });
  return {
    waiting: () => expect(page.locator('body')).toHaveAttribute('data-mutation-reply', 'waiting'),
    release: () => page.evaluate(() => window.dispatchEvent(new Event('release-mutation'))),
  };
}
async function explorerAction(page: Page, name: string) {
  await region(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function expectTreeFocusedOn(page: Page, path: string) {
  await expect(tree(page)).toBeFocused();
  await expect(tree(page)).toHaveAttribute(
    'aria-activedescendant',
    (await row(page, path).getAttribute('id'))!,
  );
  expect(await treeState(page)).toEqual({ focus: path, selected: [path] });
}

test('F2 renames in place with the stem selected, and the tree and open file follow', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'welcome.ts').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('welcome.ts');
  expect(await selection(input)).toEqual([0, 'welcome'.length]);
  await expect(row(page, 'welcome.ts')).toHaveCSS('height', '28px');
  await page.screenshot({ path: 'test-results/tree-rename.png' });
  await input.pressSequentially('hello');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(row(page, 'hello.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toHaveCount(0);
  await expectTreeFocusedOn(page, 'hello.ts');
  await expect(region(page).getByRole('tab', { name: 'hello.ts', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await read(page, 'hello.ts')).toContain('Moonbase editor module demo');
});

test('Rename… from the menu selects a folder’s whole name; Escape and an unchanged name do nothing', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'Rename…').click();
  const input = field(page, 'Rename');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('src');
  expect(await selection(input)).toEqual([0, 3]);
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, 'src');
  // Dotfiles select their whole name too.
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: '.gitignore',
      replacements: [],
    });
  });
  const before = await mutations(page);
  await row(page, '.gitignore').click();
  await tree(page).press('F2');
  expect(await selection(input)).toEqual([0, '.gitignore'.length]);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, '.gitignore');
  expect(await mutations(page)).toBe(before);
});

test('blur commits a rename, or cancels and reports when it fails', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  await input.pressSequentially('NOTES');
  await region(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(row(page, 'NOTES.md')).toBeVisible();
  expect(await exists(page, 'README.md')).toBe(false);
  expect(await treeState(page)).toEqual({ focus: 'NOTES.md', selected: ['NOTES.md'] });
  await expect(tree(page)).not.toBeFocused();
  const before = await mutations(page);
  await row(page, 'NOTES.md').click();
  await tree(page).press('F2');
  await input.fill('a/b.md');
  await region(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(region(page).getByRole('alert')).toContainText('can’t contain “/”');
  expect(await mutations(page)).toBe(before);
  // Selecting another row while the rename runs keeps that selection.
  await row(page, 'NOTES.md').click();
  await tree(page).press('F2');
  await input.pressSequentially('LATER');
  const reply = await holdNextMutation(page);
  await row(page, 'welcome.ts').click();
  await reply.waiting();
  await reply.release();
  await expect(row(page, 'LATER.md')).toBeVisible();
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, 'welcome.ts');
});

test('the window losing focus keeps the name being typed', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  await input.pressSequentially('REA');
  // As on ⌘Tab: the field blurs while the document has lost focus.
  await input.evaluate((element) => {
    document.hasFocus = () => false;
    element.blur();
    Reflect.deleteProperty(document, 'hasFocus');
  });
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('REA.md');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('REA.md');
  expect(await exists(page, 'README.md')).toBe(true);
  expect(await mutations(page)).toBe(0);
  await input.press('Escape');
  await expectTreeFocusedOn(page, 'README.md');
  expect(await mutations(page)).toBe(0);
});

test('a rename may change only case, keeps surrounding spaces, and refuses only spaces', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  await input.fill('readme.md');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectTreeFocusedOn(page, 'readme.md');
  expect(await exists(page, 'README.md')).toBe(false);
  expect(await read(page, 'readme.md')).toContain('# Volatile demo');
  expect(await mutations(page)).toBe(1);
  // An untouched name with spaces around it is unchanged.
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: ' notes ',
      replacements: [],
    });
  });
  // The row's accessible name drops the leading space.
  await row(page, 'notes ').click();
  await tree(page).press('F2');
  await expect(input).toHaveValue(' notes ');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(tree(page)).toBeFocused();
  expect(await treeState(page)).toEqual({ focus: ' notes ', selected: [' notes '] });
  expect(await mutations(page)).toBe(2);
  await tree(page).press('F2');
  await input.fill('   ');
  await input.press('Enter');
  await expect(tree(page).getByRole('alert')).toHaveText('Enter a name.');
  await input.press('Escape');
  expect(await mutations(page)).toBe(2);
});

test('Enter shows errors beside the field and keeps it open', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  const error = tree(page).getByRole('alert');
  await input.fill('docs/README.md');
  await input.press('Enter');
  await expect(error).toHaveText('A name can’t contain “/”.');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription('A name can’t contain “/”.');
  await page.screenshot({ path: 'test-results/tree-rename-error.png' });
  // Typing clears the error; the backend's own refusals show the same way.
  await input.fill('..');
  await expect(error).toHaveCount(0);
  await input.press('Enter');
  await expect(error).toContainText('exact relative path');
  await expect(input).toBeFocused();
  await input.fill('');
  await input.press('Enter');
  await expect(error).toHaveText('Enter a name.');
  // An open buffer at the destination refuses replacement after consent.
  await input.fill('welcome.ts');
  await input.press('Enter');
  const prompt = page.getByRole('dialog', { name: 'Replace welcome.ts?', exact: true });
  await prompt.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(error).toContainText('open buffers');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, 'README.md');
  expect(await read(page, 'README.md')).toContain('# Volatile demo');
  expect(await mutations(page)).toBe(0);
});

test('replacing an existing entry asks first; Cancel returns to the name', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  await input.fill('ignored.txt');
  await input.press('Enter');
  const prompt = page.getByRole('dialog', { name: 'Replace ignored.txt?', exact: true });
  await expect(prompt).toContainText('ignored.txt already exists and will be replaced.');
  await expect(prompt.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/tree-replace.png' });
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('ignored.txt');
  expect(await mutations(page)).toBe(0);
  // Escape answers Cancel too.
  await input.press('Enter');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Enter');
  await prompt.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, 'ignored.txt');
  expect(await read(page, 'ignored.txt')).toContain('# Volatile demo');
  expect(await exists(page, 'README.md')).toBe(false);
});

test('a replace prompt raised by blur returns focus where it went, or to the tree', async ({
  page,
}) => {
  await page.goto('/');
  const tab = region(page).getByRole('tab', { name: 'welcome.ts', exact: true });
  const prompt = page.getByRole('dialog', { name: 'Replace ignored.txt?', exact: true });
  const input = field(page, 'Rename');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  await input.fill('ignored.txt');
  await tab.click();
  await expect(prompt.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(tab).toBeFocused();
  expect(await mutations(page)).toBe(0);
  // Focus that went nowhere comes back to the tree.
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  await input.fill('ignored.txt');
  await input.evaluate((element) => element.blur());
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectTreeFocusedOn(page, 'README.md');
  // Replacing returns focus the same way.
  await tree(page).press('F2');
  await input.fill('ignored.txt');
  await tab.click();
  await prompt.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(tab).toBeFocused();
  expect(await read(page, 'ignored.txt')).toContain('# Volatile demo');
  expect(await exists(page, 'README.md')).toBe(false);
});

test('an Enter commit left while it runs leaves focus and selection with the user', async ({
  page,
}) => {
  await page.goto('/');
  const tab = region(page).getByRole('tab', { name: 'welcome.ts', exact: true });
  const input = field(page, 'Rename');
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  await input.fill('refused.md');
  await page.evaluate(() =>
    window.demo.memory.failNext('mutate', 'Injected refusal', false, 'InvalidInput'),
  );
  const reply = await holdNextMutation(page);
  await input.press('Enter');
  await reply.waiting();
  await tab.click();
  await expect(tab).toBeFocused();
  await reply.release();
  await expect(tree(page).getByRole('alert')).toContainText('Injected refusal');
  await expect(tab).toBeFocused();
  // A completed one keeps a row selected meanwhile.
  await input.fill('done.md');
  const done = await holdNextMutation(page);
  await input.press('Enter');
  await done.waiting();
  await row(page, 'welcome.ts').click();
  await done.release();
  await expect(input).toHaveCount(0);
  await expect(row(page, 'done.md')).toBeVisible();
  await expectTreeFocusedOn(page, 'welcome.ts');
});

test('keys typed in the name field stay out of the tree', async ({ page }) => {
  await page.goto('/?clipboard');
  await page.evaluate(() => {
    window.demo.selectClipboardImports = async () => {
      throw new Error('Field paste imported files');
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await row(page, 'README.md').click();
  const before = await treeState(page);
  await tree(page).press('F2');
  const input = field(page, 'Rename');
  for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home', 'ArrowRight', 'ArrowLeft', 'F2', ' '])
    await input.press(key);
  await input.press('ControlOrMeta+a');
  await input.pressSequentially('x');
  await expect(input).toHaveValue('x');
  await input.press('Backspace');
  await input.press('ControlOrMeta+Backspace');
  await input.press('Shift+F10');
  await input.press('ControlOrMeta+v');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await treeState(page)).toEqual(before);
  await input.press('Escape');
  await expectTreeFocusedOn(page, 'README.md');
  expect(await mutations(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('New File… and New Folder… on a folder type the name first among its children', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'New File…').click();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'true');
  const file = field(page, 'New file name');
  await expect(file).toBeFocused();
  await expect(file).toHaveValue('');
  const placeholder = tree(page).getByRole('treeitem', { name: 'New file', exact: true });
  await expect(placeholder).toHaveAttribute('aria-level', '2');
  await expect(placeholder).toHaveAttribute('aria-posinset', '1');
  await page.screenshot({ path: 'test-results/tree-new-file.png' });
  await file.fill('made.ts');
  await file.press('Enter');
  await expect(file).toHaveCount(0);
  await expect(region(page).getByRole('tab', { name: 'src/made.ts', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectTreeFocusedOn(page, 'src/made.ts');
  expect(await read(page, 'src/made.ts')).toBe('');
  // Inside a collapsed folder, a nested path is refused, and an empty name cancels.
  await row(page, 'src').click();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'New Folder…').click();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'true');
  const folder = field(page, 'New folder name');
  await folder.fill('lib/deep');
  await folder.press('Enter');
  await expect(tree(page).getByRole('alert')).toHaveText('A name can’t contain “/”.');
  await folder.fill('lib');
  await folder.press('Enter');
  await expect(folder).toHaveCount(0);
  await expectTreeFocusedOn(page, 'src/lib');
  await expect(row(page, 'src/lib')).toHaveAttribute('aria-expanded', 'false');
  const before = await mutations(page);
  await row(page, 'src').click({ button: 'right' });
  await item(page, 'New File…').click();
  await field(page, 'New file name').press('Enter');
  await expect(field(page, 'New file name')).toHaveCount(0);
  await expect(tree(page)).toBeFocused();
  expect(await mutations(page)).toBe(before);
});

test('the … menu creates in the focused folder, a focused file’s folder, or the root', async ({
  page,
}) => {
  await page.goto('/');
  await row(page, 'src').click();
  await row(page, 'src/example.ts').click();
  await explorerAction(page, 'New Folder…');
  const folder = field(page, 'New folder name');
  await expect(folder).toBeFocused();
  await expect(tree(page).getByRole('treeitem', { name: 'New folder' })).toHaveAttribute(
    'aria-level',
    '2',
  );
  await folder.fill('nested');
  await folder.press('Enter');
  await expectTreeFocusedOn(page, 'src/nested');
  await explorerAction(page, 'New File…');
  const file = field(page, 'New file name');
  await expect(file).toBeFocused();
  await expect(tree(page).getByRole('treeitem', { name: 'New file' })).toHaveAttribute(
    'aria-level',
    '3',
  );
  await file.press('Escape');
  await expectTreeFocusedOn(page, 'src/nested');
  await row(page, 'README.md').click();
  await explorerAction(page, 'New File…');
  await expect(tree(page).getByRole('treeitem', { name: 'New file' })).toHaveAttribute(
    'aria-posinset',
    '1',
  );
  await expect(tree(page).getByRole('treeitem', { name: 'New file' })).toHaveAttribute(
    'aria-level',
    '1',
  );
  // Blur creates a typed name.
  await file.fill('root.txt');
  await region(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await expect(file).toHaveCount(0);
  await expect(row(page, 'root.txt')).toBeVisible();
  await expect(region(page).getByRole('tab', { name: 'root.txt', exact: true })).toBeVisible();
  // From the Changes view, it shows the files first.
  await region(page).getByRole('button', { name: 'Changes' }).click();
  await explorerAction(page, 'New File…');
  await expect(field(page, 'New file name')).toBeFocused();
  await field(page, 'New file name').press('Escape');
  await expect(field(page, 'New file name')).toHaveCount(0);
});

test('Duplicate… types a copy’s name right after its source', async ({ page }) => {
  await page.goto('/');
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  const input = field(page, 'Duplicate as');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('README copy.md');
  expect(await selection(input)).toEqual([0, 'README copy'.length]);
  const placeholder = tree(page).getByRole('treeitem', {
    name: 'Copy of README.md',
    exact: true,
  });
  expect(Number(await placeholder.getAttribute('aria-posinset'))).toBe(
    Number(await row(page, 'README.md').getAttribute('aria-posinset')) + 1,
  );
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expectTreeFocusedOn(page, 'README copy.md');
  expect(await read(page, 'README copy.md')).toBe(await read(page, 'README.md'));
  // A copy onto its own name is refused beside the field.
  const copies = await mutations(page);
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  await input.fill('readme.md');
  await input.press('Enter');
  await expect(tree(page).getByRole('alert')).toHaveText(
    'Choose a different name from the original.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(await mutations(page)).toBe(copies);
  await input.press('Escape');
  // Escape leaves no copy.
  const before = await mutations(page);
  await row(page, 'README.md').click({ button: 'right' });
  await item(page, 'Duplicate…').click();
  await input.press('Escape');
  await expect(placeholder).toHaveCount(0);
  await expectTreeFocusedOn(page, 'README.md');
  expect(await mutations(page)).toBe(before);
});

test('an edit ends with its checkout, and a late reply after disposal opens nothing', async ({
  page,
}) => {
  await page.goto('/');
  const second = page.getByRole('region', { name: 'Second editor', exact: true });
  await page.evaluate(() => {
    const editor = window.demo.second,
      mutate = editor.mutate.bind(editor);
    editor.mutate = async (input) => {
      const result = await mutate(input);
      await new Promise<void>((resolve) => {
        window.addEventListener('release-create', () => resolve(), { once: true });
        document.body.dataset.createReply = 'waiting';
      });
      return result;
    };
    editor.open = async () => {
      document.body.dataset.detachedCreateOpen = 'true';
      return false;
    };
  });
  await second.getByRole('button', { name: 'Explorer actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New File…', exact: true }).click();
  const input = second.getByRole('textbox', { name: 'New file name', exact: true });
  await input.fill('delayed.ts');
  await input.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-create-reply', 'waiting');
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent === 'Dispose second editor')!
      .click(),
  );
  await expect(second).toHaveCount(0);
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('release-create'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(await page.locator('body').getAttribute('data-detached-create-open')).toBeNull();
  expect(await read(page, 'delayed.ts')).toBe('');
  // Closing the first checkout drops its edit without committing it.
  await row(page, 'README.md').click();
  await tree(page).press('F2');
  await field(page, 'Rename').fill('closed.md');
  const before = await mutations(page);
  await page.evaluate(() => window.demo.first.closeCheckout(window.demo.checkout));
  await expect(field(page, 'Rename')).toHaveCount(0);
  expect(await mutations(page)).toBe(before);
  expect(await exists(page, 'closed.md')).toBe(false);
});
