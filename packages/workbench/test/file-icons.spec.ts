import { test, expect, type Page } from '@playwright/test';
import { findFileIcon } from '@moonbase/ui/file-icons';

const iconsOf = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, findFileIcon(name)]));

test('whole names take their own icon before their extension', () => {
  expect(
    iconsOf([
      'package.json',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'tsconfig.json',
      'tsconfig.base.json',
      'jsconfig.json',
      'Dockerfile',
      'Dockerfile.dev',
      'compose.yaml',
      '.gitignore',
      '.gitattributes',
      'README.md',
      'README',
      'LICENSE',
      'LICENSE-MIT',
      'LICENCE.txt',
      '.env',
      '.env.local',
      'Makefile',
    ]),
  ).toEqual({
    'package.json': 'package',
    'bun.lock': 'lock',
    'bun.lockb': 'lock',
    'package-lock.json': 'lock',
    'pnpm-lock.yaml': 'lock',
    'yarn.lock': 'lock',
    'tsconfig.json': 'config',
    'tsconfig.base.json': 'config',
    'jsconfig.json': 'config',
    Dockerfile: 'docker',
    'Dockerfile.dev': 'docker',
    'compose.yaml': 'docker',
    '.gitignore': 'git',
    '.gitattributes': 'git',
    'README.md': 'readme',
    README: 'readme',
    LICENSE: 'license',
    'LICENSE-MIT': 'license',
    'LICENCE.txt': 'license',
    '.env': 'env',
    '.env.local': 'env',
    Makefile: 'build',
  });
  // A name that only starts like a special one is judged by its extension.
  expect(iconsOf(['readme-check.ts', 'license-check.ts', 'package.ts', 'tsconfig.ts'])).toEqual({
    'readme-check.ts': 'typescript',
    'license-check.ts': 'typescript',
    'package.ts': 'typescript',
    'tsconfig.ts': 'typescript',
  });
});

test('extensions ignore case and paths, and multi-dot names use their last extension', () => {
  expect(
    iconsOf([
      'main.ts',
      'MAIN.TS',
      'src/lib/Util.Tsx',
      'index.mjs',
      'notes.md',
      'logo.SVG',
      'photo.jpeg',
      'ci.yml',
      'run.sh',
      'data.csv',
      'archive.tar.gz',
      'env.d.ts',
      'vite.config.ts',
      'files-tree.spec.ts',
      'util.test.tsx',
      'notes.test.md',
    ]),
  ).toEqual({
    'main.ts': 'typescript',
    'MAIN.TS': 'typescript',
    'src/lib/Util.Tsx': 'react',
    'index.mjs': 'javascript',
    'notes.md': 'markdown',
    'logo.SVG': 'image',
    'photo.jpeg': 'image',
    'ci.yml': 'config',
    'run.sh': 'shell',
    'data.csv': 'table',
    'archive.tar.gz': 'archive',
    // No declaration icon: a `.d.ts` file is TypeScript.
    'env.d.ts': 'typescript',
    'vite.config.ts': 'typescript',
    'files-tree.spec.ts': 'test',
    'util.test.tsx': 'test',
    // Only scripts are tests.
    'notes.test.md': 'markdown',
  });
  // A file named `test.ts` is TypeScript, not a test of something.
  expect(findFileIcon('test.ts')).toBe('typescript');
});

test('dotfiles, names without an extension and unknown extensions fall back to a file', () => {
  expect(
    iconsOf([
      '.zshrc',
      '.npmrc',
      '.hidden',
      '.hidden.ts',
      'LICENSES',
      'notes',
      'data.xyz',
      'odd.',
      '',
    ]),
  ).toEqual({
    '.zshrc': 'shell',
    '.npmrc': 'config',
    // A dotfile's leading dot is part of its name, not an extension.
    '.hidden': 'file',
    '.hidden.ts': 'typescript',
    LICENSES: 'file',
    notes: 'file',
    'data.xyz': 'file',
    'odd.': 'file',
    '': 'file',
  });
});

const tree = (page: Page) =>
  page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('tree', { name: 'Files', exact: true });
/** The `tabler-icon-*` class of a row's icon. */
const rowIcon = async (page: Page, name: string) =>
  (
    await tree(page)
      .getByRole('treeitem', { name, exact: true })
      .locator('svg')
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
  await expect(unknown.locator('svg')).toHaveAttribute('aria-hidden', 'true');
});
