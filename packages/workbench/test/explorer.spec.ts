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
    await expect(ignored.getByText('ignored.ts', { exact: true })).toHaveCSS(
      'color',
      'rgb(139, 144, 160)',
    );
    await expect(normal.getByText('example.ts', { exact: true })).toHaveCSS(
      'color',
      'rgb(180, 184, 198)',
    );
    await ignored.click();
    await expect(
      region.getByRole('textbox', { name: 'src/ignored.ts editor', exact: true }),
    ).toBeVisible();
    await expect(ignored).toHaveAttribute('aria-selected', 'true');
    await expect(ignored.getByText('ignored.ts', { exact: true })).toHaveCSS(
      'color',
      'rgb(139, 144, 160)',
    );
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

test('Git status colours changed files, marks them with a letter and dots folders above them', async ({
  page,
}) => {
  await page.goto('/');
  const region = page.getByRole('region', { name: 'First editor', exact: true });
  const tree = region.getByRole('tree', { name: 'Files', exact: true });
  await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { first, checkout, memory } = window.demo;
    memory.externalWrite({ checkout, path: 'src/example.ts' }, 'export const changed = true;\n');
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'notes.md',
      replacements: [],
    });
  });
  const folder = tree.getByRole('treeitem', { name: 'src, contains changes', exact: true });
  const untracked = tree.getByRole('treeitem', { name: 'notes.md, untracked', exact: true });
  await expect(folder).toBeVisible();
  await expect(untracked).toBeVisible();
  // Staged and unstaged edits to one file show it once, as modified.
  await expect(
    tree.getByRole('treeitem', { name: 'welcome.ts, modified', exact: true }),
  ).toHaveCount(1);
  const sand = 'rgb(217, 200, 160)',
    green = 'rgb(167, 217, 139)';
  await expect(folder.locator('[data-git-status="modified"]')).toHaveCSS('background-color', sand);
  await expect(folder.locator('[data-git-status]')).toHaveText('');
  await expect(untracked.locator('[data-git-status="untracked"]')).toHaveText('U');
  await expect(untracked.locator('[data-git-status="untracked"]')).toHaveCSS('color', green);
  await expect(untracked.getByText('notes.md', { exact: true })).toHaveCSS('color', green);
  // A clean file keeps its plain name and no mark.
  const clean = tree.getByRole('treeitem', { name: 'README.md', exact: true });
  await expect(clean.locator('[data-git-status]')).toHaveCount(0);
  await expect(clean.getByText('README.md', { exact: true })).toHaveCSS(
    'color',
    'rgb(180, 184, 198)',
  );

  await folder.click();
  const modified = tree.getByRole('treeitem', { name: 'src/example.ts, modified', exact: true });
  await expect(modified.locator('[data-git-status="modified"]')).toHaveText('M');
  await expect(modified.getByText('example.ts', { exact: true })).toHaveCSS('color', sand);
  // The unsaved dot and the letter share the trailing slot.
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'src/example.ts' }, { intent: 'keep' });
    first.edit({ checkout, path: 'src/example.ts' }, 'export const changed = false;\n');
  });
  const dirty = tree.getByRole('treeitem', {
    name: 'src/example.ts, unsaved, modified',
    exact: true,
  });
  await expect(dirty).toBeVisible();
  await expect(dirty.locator('[aria-hidden="true"]').last()).toHaveText('•M');
  await page.screenshot({ path: 'test-results/explorer-git-status.png', fullPage: true });

  await region.getByRole('button', { name: 'Changes', exact: true }).click();
  const changes = region.getByRole('region', { name: 'Changes', exact: true });
  const changedRow = changes.getByRole('button', { name: 'src/example.ts', exact: true });
  await expect(changedRow).toHaveAttribute('aria-description', 'modified');
  await expect(changedRow.locator('[data-git-status="modified"]')).toHaveText('M');
  const untrackedRow = region
    .getByRole('region', { name: 'Untracked', exact: true })
    .getByRole('button', { name: 'notes.md', exact: true });
  await expect(untrackedRow.locator('[data-git-status="untracked"]')).toHaveText('U');
  await expect(untrackedRow.locator('[data-git-status="untracked"]')).toHaveCSS('color', green);
});

test('conflicts mark their folders apart and a path both sides deleted opens nothing', async ({
  page,
}) => {
  await page.goto('/?conflicts');
  const region = page.getByRole('region', { name: 'First editor', exact: true });
  const tree = region.getByRole('tree', { name: 'Files', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'merge, contains conflicts', exact: true });
  await expect(folder).toBeVisible();
  // A folder above other changes still says so, with a round dot.
  await page.evaluate(() => {
    const { checkout, memory } = window.demo;
    memory.externalWrite({ checkout, path: 'src/example.ts' }, 'export const changed = true;\n');
  });
  const changed = tree.getByRole('treeitem', { name: 'src, contains changes', exact: true });
  await expect(changed.locator('[data-git-status="modified"]')).toHaveCSS('transform', 'none');
  // The conflict's dot is a diamond, so its shape tells it apart, not only its colour.
  await expect(folder.locator('[data-git-status="conflicted"]')).not.toHaveCSS('transform', 'none');
  await folder.click();
  await expect(
    tree.getByRole('treeitem', { name: 'merge/both.ts, conflicted', exact: true }),
  ).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /gone\.ts/ })).toHaveCount(0);

  await region.getByRole('button', { name: 'Changes', exact: true }).click();
  const conflicts = region.getByRole('region', { name: 'Conflicts', exact: true });
  const gone = conflicts.getByRole('button', { name: 'merge/gone.ts', exact: true });
  await expect(gone).toBeDisabled();
  await expect(gone).toHaveAttribute('aria-description', 'conflicted, deleted on both sides');
  await expect(gone).toHaveAttribute('title', 'merge/gone.ts (deleted on both sides)');
  const both = conflicts.getByRole('button', { name: 'merge/both.ts', exact: true });
  await expect(both).toBeEnabled();
  await expect(both).toHaveAttribute('aria-description', 'conflicted');
  await both.click();
  await expect(
    region.getByRole('textbox', { name: 'merge/both.ts editor', exact: true }),
  ).toBeVisible();
  await expect(both).toHaveAttribute('aria-current', 'true');
});
