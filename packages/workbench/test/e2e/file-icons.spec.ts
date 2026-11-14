import { test, expect, type Page } from '@playwright/test';

const tree = (page: Page) =>
  page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('tree', { name: 'Files', exact: true });
/** A tree row's own type icon, beside its (nested) disclosure chevron. */
const typeIcon = ':scope > svg';
/** The `tabler-icon-*` class of a row's icon. */
const rowIcon = async (page: Page, name: string) =>
  (
    await tree(page)
      .getByRole('treeitem', { name, exact: true })
      .locator(typeIcon)
      .getAttribute('class')
  )
    ?.split(' ')
    .find((name) => name.startsWith('tabler-icon-'));

test('tree rows show the icon for their file type', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    for (const destination of ['notes.md', 'data.xyz'])
      await first.mutate({
        checkout,
        kind: 'create-file',
        sources: [],
        destination,
        replacements: [],
      });
  });
  const unknown = tree(page).getByRole('treeitem', { name: 'data.xyz, untracked', exact: true });
  await expect(unknown).toBeVisible();
  expect(await rowIcon(page, 'welcome.ts, modified')).toBe('tabler-icon-brand-typescript');
  expect(await rowIcon(page, 'notes.md, untracked')).toBe('tabler-icon-markdown');
  expect(await rowIcon(page, 'data.xyz, untracked')).toBe('tabler-icon-file');
  // The icon stays out of the accessible name.
  await expect(unknown.locator(typeIcon)).toHaveAttribute('aria-hidden', 'true');
});

test('a tab for a file known by its name shows the same icon as its tree row', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'package.json',
      text: '{}\n',
    });
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    await first.open({ checkout, path: 'package.json' }, { intent: 'keep' });
  });
  const strip = page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('tablist', { name: 'Open files', exact: true });
  for (const [path, row, icon] of [
    ['README.md', 'README.md', 'tabler-icon-book'],
    ['package.json', 'package.json, untracked', 'tabler-icon-package'],
  ] as const) {
    const tab = strip.getByRole('tab', { name: path, exact: true });
    // No extension mark (MD, {}) beside the name.
    await expect(tab).toHaveText(path);
    await expect(tab.locator(`svg.${icon}`)).toBeVisible();
    expect(await rowIcon(page, row)).toBe(icon);
  }
});
