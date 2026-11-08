import { test, expect, type Page } from '@playwright/test';
import { findFileIcon, findFileTypeMark } from '@moonbase/ui/file-icons';

const iconsOf = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, findFileIcon(name)]));

test('whole names take their own icon before their extension', () => {
  expect(
    iconsOf([
      'package.json',
      'PACKAGE.JSON',
      'go.mod',
      'go.work',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig-build.json',
      'jsconfig.json',
      'Dockerfile',
      'Dockerfile.dev',
      'Containerfile',
      'compose.yaml',
      '.gitignore',
      '.gitattributes',
      '.git-blame-ignore-revs',
      'README.md',
      'README',
      'LICENSE',
      'LICENSE-MIT',
      'LICENSE-APACHE',
      'LICENCE.txt',
      'LICENSE.rst',
      'COPYING.LESSER',
      'UNLICENSE',
      '.env',
      '.env.local',
      '.envrc',
      '.bash_profile',
      '.bash_aliases',
      'Makefile',
    ]),
  ).toEqual({
    'package.json': 'package',
    'PACKAGE.JSON': 'package',
    'go.mod': 'package',
    'go.work': 'package',
    'bun.lock': 'lock',
    'bun.lockb': 'lock',
    'package-lock.json': 'lock',
    'pnpm-lock.yaml': 'lock',
    'yarn.lock': 'lock',
    'tsconfig.json': 'config',
    'tsconfig.base.json': 'config',
    'tsconfig-build.json': 'config',
    'jsconfig.json': 'config',
    Dockerfile: 'docker',
    'Dockerfile.dev': 'docker',
    Containerfile: 'docker',
    'compose.yaml': 'docker',
    '.gitignore': 'git',
    '.gitattributes': 'git',
    '.git-blame-ignore-revs': 'git',
    'README.md': 'readme',
    README: 'readme',
    LICENSE: 'license',
    'LICENSE-MIT': 'license',
    'LICENSE-APACHE': 'license',
    'LICENCE.txt': 'license',
    'LICENSE.rst': 'license',
    'COPYING.LESSER': 'license',
    UNLICENSE: 'license',
    '.env': 'env',
    '.env.local': 'env',
    '.envrc': 'env',
    '.bash_profile': 'shell',
    '.bash_aliases': 'shell',
    Makefile: 'build',
  });
  // A name that only starts like a special one is judged by its extension.
  expect(
    iconsOf([
      'readme-check.ts',
      'license-check.ts',
      'license-check',
      'copying-helper',
      'package.ts',
      'tsconfig.ts',
      'dockerfile.md',
      'Dockerfile.ts',
    ]),
  ).toEqual({
    'readme-check.ts': 'typescript',
    'license-check.ts': 'typescript',
    'license-check': 'file',
    'copying-helper': 'file',
    'package.ts': 'typescript',
    'tsconfig.ts': 'typescript',
    'dockerfile.md': 'markdown',
    'Dockerfile.ts': 'typescript',
  });
});

test('extensions ignore case and paths, and multi-dot names use their last extension', () => {
  expect(
    iconsOf([
      'main.ts',
      'MAIN.TS',
      'src/lib/Util.Tsx',
      'a.lock/b',
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
    // Only the base name counts, not a dotted folder above it.
    'a.lock/b': 'file',
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

test('names shared with Object.prototype are plain unknown files', () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  for (const name of [...names, ...names.map((name) => `file.${name}`)]) {
    expect(findFileIcon(name), name).toBe('file');
    expect(findFileTypeMark(name), name).toBeNull();
  }
});

test('type marks stand in only for icons chosen by extension, alike across siblings', () => {
  const labelsOf = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, findFileTypeMark(name)?.label ?? null]));
  // A whole name, pattern or test file shows its icon, as in the tree.
  expect(
    labelsOf([
      'package.json',
      'tsconfig.json',
      'pnpm-lock.yaml',
      'docker-compose.yml',
      'README.md',
      '.env',
      'foo.spec.ts',
    ]),
  ).toEqual({
    'package.json': null,
    'tsconfig.json': null,
    'pnpm-lock.yaml': null,
    'docker-compose.yml': null,
    'README.md': null,
    '.env': null,
    'foo.spec.ts': null,
  });
  // Extensions sharing an icon share its mark, or its lack of one.
  expect(
    labelsOf([
      'a.ts',
      'a.mts',
      'a.cts',
      'a.js',
      'a.cjs',
      'a.json',
      'a.jsonc',
      'a.json5',
      'a.md',
      'a.markdown',
      'a.css',
      'a.less',
      'a.scss',
      'a.sass',
      'a.html',
      'a.htm',
      'a.sh',
      'a.zsh',
      'a.yml',
      'a.yaml',
      'a.kt',
      'a.kts',
      'a.png',
    ]),
  ).toEqual({
    'a.ts': 'TS',
    'a.mts': 'TS',
    'a.cts': 'TS',
    'a.js': 'JS',
    'a.cjs': 'JS',
    'a.json': '{}',
    'a.jsonc': '{}',
    'a.json5': '{}',
    'a.md': 'MD',
    'a.markdown': 'MD',
    'a.css': '#',
    'a.less': '#',
    'a.scss': '#',
    'a.sass': '#',
    'a.html': '<>',
    'a.htm': '<>',
    'a.sh': '$',
    'a.zsh': '$',
    'a.yml': 'YML',
    'a.yaml': 'YML',
    'a.kt': null,
    'a.kts': null,
    'a.png': null,
  });
  expect(findFileTypeMark('Main.TSX')).toEqual({ label: 'TSX', hue: 'periwinkle' });
  expect(findFileTypeMark('main.jsx')).toEqual({ label: 'JSX', hue: 'sand' });
});

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
