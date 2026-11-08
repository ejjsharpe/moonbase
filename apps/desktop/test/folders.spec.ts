import { test, expect } from '@playwright/test';

test('a plain-folder project offers Initialize Git, which makes it a Git project with its tabs', async ({
  page,
}) => {
  await page.goto('/?chat&design');
  await page.evaluate(async () => {
    const { first } = window.demo;
    const notes = await first.openCheckout('/demo/notes');
    await first.open({ checkout: notes, path: 'notes.md' }, { intent: 'keep' });
    first.edit({ checkout: notes, path: 'notes.md' }, '# Notes\n\nAn unsaved draft.\n');
  });
  const projects = page.getByRole('group', { name: 'Project tabs', exact: true });
  const folder = projects.getByRole('tab', { name: 'notes', exact: true });
  await folder.hover();
  await expect(
    page.locator('[data-side="right"] > [data-side="right"]').filter({ hasText: '/demo/notes' }),
  ).toContainText('No Git repository');
  await folder.click();
  await expect(folder).toHaveAttribute('aria-selected', 'true');
  // A plain folder has no branch, worktree switcher or Changes view.
  const editor = page.getByRole('textbox', { name: 'notes.md editor', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('button', { name: /^Switch worktree/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Sidebar view', exact: true })).toHaveCount(0);
  const initialize = page.getByRole('button', { name: 'Initialize Git', exact: true });
  await page.screenshot({ path: test.info().outputPath('plain-folder.png') });

  await initialize.click();
  const repository = projects.getByRole('tab', { name: 'notes · main', exact: true });
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  await expect(initialize).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Switch worktree, notes · main', exact: true }),
  ).toBeVisible();
  // Its tab and unsaved draft move to the Git project.
  await expect(editor).toBeVisible();
  expect(
    await page.evaluate(() => {
      const { recovery, buffers } = window.demo.first.getSnapshot();
      const notes = recovery.checkouts.find((checkout) => checkout.root === '/demo/notes')!;
      return {
        vcs: notes.vcs,
        openFiles: recovery.views[notes.checkoutId].openFiles,
        draft: buffers.find((buffer) => buffer.target.checkout.root === notes.root)?.text,
      };
    }),
  ).toEqual({ vcs: 'git', openFiles: ['notes.md'], draft: '# Notes\n\nAn unsaved draft.\n' });
  // Nothing is committed, so its file is untracked.
  await page
    .getByRole('group', { name: 'Sidebar view', exact: true })
    .getByRole('button', { name: /^Changes/ })
    .click();
  await expect(
    page.getByRole('region', { name: 'Untracked', exact: true }).getByRole('button', {
      name: 'notes.md',
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('initialized-folder.png') });
});

test('the project opener and chat folder menu describe a plain folder by its place', async ({
  page,
}) => {
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const { first } = window.demo;
    await first.closeCheckout(await first.openCheckout('/demo/notes'));
  });
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  const folders = page.getByRole('dialog', { name: 'Working folder', exact: true });
  await expect(folders.getByRole('button', { name: 'notes /demo', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const projects = page.getByRole('group', { name: 'Project tabs', exact: true });
  await projects.getByRole('button', { name: 'Open checkout', exact: true }).click();
  const opener = page.getByRole('dialog', { name: 'Open project', exact: true });
  await expect(opener.getByRole('button', { name: /^notes/ })).toContainText('/demo/notes');
  await opener.getByRole('button', { name: /^notes/ }).click();
  await expect(projects.getByRole('tab', { name: 'notes', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
