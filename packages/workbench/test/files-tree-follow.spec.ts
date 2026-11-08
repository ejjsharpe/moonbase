import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    /** Calls to the first editor's reveal, and how each settled. */
    revealProbe: { calls: number; results: (boolean | 'rejected')[] };
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
    return {
      focus: tree.focus,
      selected: tree.selected,
      expanded: tree.expanded,
      hideIgnored: !!tree.hideIgnoredFiles,
    };
  });
const openFile = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path }, { intent: 'keep' });
  }, path);
async function openMenu(page: Page) {
  await region(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  return page.getByRole('menu', { name: 'Explorer actions', exact: true });
}
async function toggle(page: Page, name: string, checked: boolean) {
  const menu = await openMenu(page);
  const item = menu.getByRole('menuitemcheckbox', { name, exact: true });
  await expect(item).toHaveAttribute('aria-checked', String(!checked));
  await item.click();
  // The menu stays open so the new state shows.
  await expect(item).toHaveAttribute('aria-checked', String(checked));
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}
/** Opens the demo with a fake clock, so `settle` can run the tree's follow timer at once. */
async function start(page: Page, url = '/') {
  await page.clock.install();
  await page.goto(url);
  await expect(row(page, 'src')).toHaveCount(1);
  // Every reveal the tree starts, counted as it starts and as it settles.
  await page.evaluate(() => {
    const { first } = window.demo;
    const reveal = first.reveal.bind(first);
    window.revealProbe = { calls: 0, results: [] };
    first.reveal = (target, options) => {
      window.revealProbe.calls++;
      const revealing = reveal(target, options);
      revealing.then(
        (revealed) => window.revealProbe.results.push(revealed),
        () => window.revealProbe.results.push('rejected'),
      );
      return revealing;
    };
  });
}
/**
 * Fires the timer a follow would have set, so a reveal that shouldn't happen has started by the
 * time this returns; the tree starts a reveal synchronously in that timer.
 */
async function settle(page: Page) {
  await page.clock.runFor(200);
  return page.evaluate(() => window.revealProbe.calls);
}

test('Go to and switching tabs reveal the active file in collapsed folders without taking focus', async ({
  page,
}) => {
  await page.goto('/');
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  await region(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await goTo.getByRole('combobox').fill('example');
  await goTo.getByRole('combobox').press('Enter');
  await expect(goTo).toHaveCount(0);
  const editor = region(page).getByRole('textbox', { name: 'src/example.ts editor', exact: true });
  await expect(editor).toBeFocused();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-current', 'true');
  await expect(editor).toBeFocused();

  const tabs = region(page).getByRole('tablist', { name: 'Open files', exact: true });
  await tabs.getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await expect(row(page, 'welcome.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'false');
  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Collapse All Folders', exact: true }).click();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');

  const example = tabs.getByRole('tab', { name: 'src/example.ts', exact: true });
  await example.click();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  expect((await treeState(page)).focus).toBe('src/example.ts');
  await expect(tree(page)).not.toBeFocused();
});

test('the tree leaves its own place alone while the user is in it', async ({ page }) => {
  await start(page);
  await tree(page).focus();
  await tree(page).press('End');
  const before = await treeState(page);
  await openFile(page, 'src/example.ts');
  await expect(
    region(page).getByRole('tab', { name: 'src/example.ts', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(await settle(page)).toBe(0);
  await expect(tree(page)).toBeFocused();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  expect(await treeState(page)).toEqual(before);
});

test('turning Follow Active File off stops the tree following and is saved; on reveals at once', async ({
  page,
}) => {
  await start(page);
  await toggle(page, 'Follow Active File', false);
  await openFile(page, 'src/example.ts');
  await expect(
    region(page).getByRole('tab', { name: 'src/example.ts', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(await settle(page)).toBe(0);
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  expect((await treeState(page)).selected).not.toContain('src/example.ts');
  expect(
    await page.evaluate(async () => {
      const { first, client } = window.demo;
      await first.flush();
      return (await client.command('loadRecovery', { clientId: first.clientId })).state
        .followActiveFile;
    }),
  ).toBe(false);
  // Following again reveals the file made active meanwhile, without waiting for a switch.
  await toggle(page, 'Follow Active File', true);
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(tree(page)).not.toBeFocused();
});

test('following catches up once the Files view shows again, and not on first show', async ({
  page,
}) => {
  await start(page);
  // The tree as first shown is left as restored, though welcome.ts is active.
  const restored = await treeState(page);
  expect(await settle(page)).toBe(0);
  expect(await treeState(page)).toEqual(restored);

  const nav = region(page).getByRole('group', { name: 'Sidebar view', exact: true });
  await nav.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(tree(page)).toHaveCount(0);
  await openFile(page, 'src/example.ts');
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  // Back again with the same file active, nothing more is revealed.
  await nav.getByRole('button', { name: 'Changes', exact: true }).click();
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(row(page, 'src')).toBeVisible();
  const calls = await page.evaluate(() => window.revealProbe.calls);
  expect(await settle(page)).toBe(calls);
});

test('following catches up once the sidebar is shown', async ({ page }) => {
  await start(page, '/?sidebar-hidden');
  await openFile(page, 'src/example.ts');
  const editor = region(page).getByRole('textbox', { name: 'src/example.ts editor', exact: true });
  await expect(editor).toBeVisible();
  expect(await settle(page)).toBe(0);
  await editor.focus();
  await editor.press('Meta+Shift+e');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toBeFocused();
});

test('following waits while a dialog is open and catches up once it closes', async ({ page }) => {
  await start(page);
  await region(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(goTo).toBeVisible();
  // The modal picker hides the editor from the accessibility tree, so read its state instead.
  await openFile(page, 'src/example.ts');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.demo.first.getSnapshot().recovery.views[window.demo.checkout.checkoutId].active,
      ),
    )
    .toBe('src/example.ts');
  expect(await settle(page)).toBe(0);
  expect((await treeState(page)).expanded).not.toContain('src');
  await page.keyboard.press('Escape');
  await expect(goTo).toHaveCount(0);
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
});

test('Hide Ignored Files hides ignored rows, moves the selection off them and shows them again', async ({
  page,
}) => {
  await start(page);
  await row(page, 'src').click();
  await expect(row(page, 'src/ignored.ts')).toHaveAttribute('aria-description', 'Git-ignored');
  await expect(row(page, 'ignored.txt')).toHaveAttribute('aria-description', 'Git-ignored');
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.tree(checkout, { focus: 'src/ignored.ts', selected: ['src/ignored.ts', 'README.md'] });
  });
  await toggle(page, 'Hide Ignored Files', true);
  await expect(row(page, 'ignored.txt')).toHaveCount(0);
  await expect(row(page, 'src/ignored.ts')).toHaveCount(0);
  await expect(row(page, 'src/example.ts')).toBeVisible();
  await expect(row(page, 'welcome.ts')).toBeVisible();
  await expect
    .poll(() => treeState(page))
    .toMatchObject({
      focus: 'src',
      selected: ['README.md'],
      hideIgnored: true,
    });
  const menu = await openMenu(page);
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'Hide Ignored Files', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: 'test-results/tree-hide-ignored.png' });
  await page.keyboard.press('Escape');
  await toggle(page, 'Hide Ignored Files', false);
  await expect(row(page, 'ignored.txt')).toBeVisible();
  await expect(row(page, 'src/ignored.ts')).toBeVisible();
});

test('following leaves a file in a hidden ignored folder unrevealed; Reveal Active File shows it', async ({
  page,
}) => {
  await start(page);
  // Git now ignores the whole src folder.
  await page.evaluate(async () => {
    const { client, first, checkout } = window.demo;
    const command = client.command.bind(client);
    client.command = (async (name, input, options) => {
      const result = await command(name, input, options);
      if (name === 'getIgnoredPaths' && (input as { paths: string[] }).paths.includes('src'))
        return { ...result, paths: [...(result as { paths: string[] }).paths, 'src'] };
      return result;
    }) as typeof client.command;
    await first.list(checkout);
  });
  await expect(row(page, 'src')).toHaveAttribute('aria-description', 'Git-ignored');
  await toggle(page, 'Hide Ignored Files', true);
  await expect(row(page, 'src')).toHaveCount(0);
  await openFile(page, 'src/example.ts');
  await settle(page);
  // The follow's reveal ran and declined, rather than not having run yet.
  await expect.poll(() => page.evaluate(() => window.revealProbe.results)).toEqual([false]);
  expect(await treeState(page)).toMatchObject({ expanded: [], hideIgnored: true });
  expect((await treeState(page)).selected).not.toContain('src/example.ts');

  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Reveal Active File', exact: true }).click();
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  expect((await treeState(page)).hideIgnored).toBe(false);
});
