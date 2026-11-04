import { test, expect } from '@playwright/test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';

declare global {
  interface Window {
    explorerProbe: { calls: string[]; hold: boolean; release?(): void };
    ignoreProbe: { pending: boolean; release?(): void };
  }
}

test('first folder open displays every file before Git finishes and then fades ignored entries', async ({
  page,
}) => {
  await page.goto('/');
  const region = page.getByRole('region', { name: 'First editor', exact: true });
  const tree = region.getByRole('tree', { name: 'Files', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
  await expect(folder).toBeVisible();
  await expect(region.getByRole('button', { name: 'Hide Git-ignored files' })).toHaveCount(0);
  await page.evaluate(() => {
    const { client, first, checkout } = window.demo;
    first.tree(checkout, { hideIgnored: true });
    const command = client.command.bind(client);
    window.ignoreProbe = { pending: false };
    client.command = async (name, input, options) => {
      if (name === 'getIgnoredPaths' && (input as { path: string }).path === 'src') {
        window.ignoreProbe.pending = true;
        await new Promise<void>((resolve) => {
          window.ignoreProbe.release = resolve;
        });
        window.ignoreProbe.pending = false;
      }
      return command(name, input, options);
    };
  });
  const normal = tree.getByRole('treeitem', { name: 'src/example.ts', exact: true });
  const ignored = tree.getByRole('treeitem', { name: 'src/ignored.ts', exact: true });
  await expect(normal).toHaveCount(0);
  await expect(ignored).toHaveCount(0);
  try {
    await folder.click();
    await expect(normal).toBeVisible();
    await expect(ignored).toBeVisible();
    expect(await page.evaluate(() => window.ignoreProbe.pending)).toBe(true);
    await expect(ignored).not.toHaveAttribute('aria-description');
    await page.evaluate(() => window.ignoreProbe.release?.());
    await expect(ignored).toHaveAttribute('aria-description', 'Git-ignored');
    await expect(ignored.locator('span').first()).toHaveCSS('color', 'rgb(170, 169, 182)');
    await expect(normal.locator('span').first()).toHaveCSS('color', 'rgb(185, 184, 197)');
    await ignored.click();
    await expect(
      region.getByRole('textbox', { name: 'src/ignored.ts editor', exact: true }),
    ).toBeVisible();
    await expect(ignored).toHaveAttribute('aria-selected', 'true');
    await expect(ignored.locator('span').first()).toHaveCSS('color', 'rgb(170, 169, 182)');
    await page.screenshot({ path: 'test-results/explorer-ignored-files.png', fullPage: true });
  } finally {
    await page.evaluate(() => window.ignoreProbe.release?.());
  }
});

test('collapse skips filesystem reads and reopening shows cached children during revalidation', async ({
  page,
}) => {
  await page.goto('/');
  const region = page.getByRole('region', { name: 'First editor', exact: true });
  const tree = region.getByRole('tree', { name: 'Files', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
  const child = tree.getByRole('treeitem', { name: 'src/example.ts', exact: true });
  await expect(folder).toBeVisible();
  await page.evaluate(() => {
    const { client } = window.demo;
    const command = client.command.bind(client);
    window.explorerProbe = { calls: [], hold: false };
    client.command = async (name, input, options) => {
      if (name === 'listDirectory') {
        const path = (input as { path: string }).path;
        window.explorerProbe.calls.push(path);
        if (path === 'src' && window.explorerProbe.hold)
          await new Promise<void>((resolve) => {
            window.explorerProbe.release = resolve;
          });
      }
      return command(name, input, options);
    };
  });
  await folder.click();
  await expect(child).toBeVisible();
  expect(await page.evaluate(() => window.explorerProbe.calls)).toEqual(['src']);
  await folder.click();
  await expect(child).toHaveCount(0);
  expect(await page.evaluate(() => window.explorerProbe.calls)).toEqual(['src']);
  await page.evaluate(() => {
    window.explorerProbe.hold = true;
  });
  try {
    await folder.click();
    await expect(child).toBeVisible();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => window.explorerProbe.calls)).toEqual(['src', 'src']);
    await tree.press('ArrowLeft');
    await expect(child).toHaveCount(0);
    await tree.press('ArrowRight');
    await expect(child).toBeVisible();
    expect(await page.evaluate(() => window.explorerProbe.calls)).toEqual(['src', 'src']);
    await page.screenshot({ path: 'test-results/explorer-cached-navigation.png', fullPage: true });
  } finally {
    await page.evaluate(() => window.explorerProbe.release?.());
  }
});

test('large expanded trees keep navigation and selection virtualized', async ({ page }) => {
  await page.goto('/');
  const tree = page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('tree', { name: 'Files', exact: true });
  await expect(tree).toBeVisible();
  await page.evaluate(async () => {
    const { first, client, checkout } = window.demo;
    const command = client.command.bind(client);
    const entries = Array.from({ length: 10000 }, (_, index) => ({
      path: `folder-${String(index).padStart(5, '0')}`,
      directory: true,
      ignored: false,
    }));
    client.command = async (name, input, options) => {
      const result = await command(name, input, options);
      if (name === 'listDirectory' && (input as { path: string }).path === '')
        (result as DirectoryListing).entries = entries;
      return result;
    };
    await first.list(checkout);
    first.tree(checkout, { expanded: entries.map((entry) => entry.path) });
  });
  const firstFolder = tree.getByRole('treeitem', { name: 'folder-00000', exact: true });
  await expect(firstFolder).toBeVisible();
  await tree.focus();
  await tree.press('End');
  const lastFolder = tree.getByRole('treeitem', { name: 'folder-09999', exact: true });
  await expect(lastFolder).toBeVisible();
  await expect(lastFolder).toHaveAttribute('aria-posinset', '10000');
  await expect(lastFolder).toHaveAttribute('aria-setsize', '10000');
  expect(await tree.getByRole('treeitem').count()).toBeLessThan(80);
  await tree.press('Shift+Home');
  await expect(firstFolder).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.demo.first.getSnapshot().recovery.views[window.demo.checkout.checkoutId].tree
          .selected.length,
    ),
  ).toBe(10000);
  expect(await tree.getByRole('treeitem').count()).toBeLessThan(80);
  await expect(firstFolder).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: 'test-results/explorer-large-tree.png', fullPage: true });
});
