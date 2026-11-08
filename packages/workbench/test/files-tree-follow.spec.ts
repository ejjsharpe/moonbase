import { test, expect, type Page } from '@playwright/test';

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
      hideIgnored: tree.hideIgnored,
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
/** Lets a reveal that shouldn't happen have time to happen. */
const settle = (page: Page) => page.waitForTimeout(400);

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
  await page.goto('/');
  await tree(page).focus();
  await tree(page).press('End');
  const before = await treeState(page);
  await openFile(page, 'src/example.ts');
  await expect(
    region(page).getByRole('tab', { name: 'src/example.ts', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await settle(page);
  await expect(tree(page)).toBeFocused();
  await expect(row(page, 'src')).toHaveAttribute('aria-expanded', 'false');
  expect(await treeState(page)).toEqual(before);
});

test('turning Follow Active File off stops the tree following and is saved', async ({ page }) => {
  await page.goto('/');
  await toggle(page, 'Follow Active File', false);
  await openFile(page, 'src/example.ts');
  await settle(page);
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
  // Following again picks up from the next switch.
  await toggle(page, 'Follow Active File', true);
  await region(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await openFile(page, 'src/example.ts');
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
});

test('Hide Ignored Files hides ignored rows, moves the selection off them and shows them again', async ({
  page,
}) => {
  await page.goto('/');
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
  await page.goto('/');
  await expect(row(page, 'src')).toBeVisible();
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
  expect(await treeState(page)).toMatchObject({ expanded: [], hideIgnored: true });
  expect((await treeState(page)).selected).not.toContain('src/example.ts');

  await openMenu(page);
  await page.getByRole('menuitem', { name: 'Reveal Active File', exact: true }).click();
  await expect(row(page, 'src/example.ts')).toHaveAttribute('aria-selected', 'true');
  expect((await treeState(page)).hideIgnored).toBe(false);
});
