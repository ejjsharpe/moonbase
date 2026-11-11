import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFileIcon, findFileTypeMark } from '@moonbase/ui/file-icons';

const iconsOf = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, findFileIcon(name)]));

test('whole names take their own icon before their extension', () => {
  assert.deepEqual(
    iconsOf([
      'package.json',
      'PACKAGE.JSON',
      'bun.lock',
      'Dockerfile.dev',
      'LICENSE-MIT',
      '.env.local',
    ]),
    {
      'package.json': 'package',
      'PACKAGE.JSON': 'package',
      'bun.lock': 'lock',
      'Dockerfile.dev': 'docker',
      'LICENSE-MIT': 'license',
      '.env.local': 'env',
    },
  );
  // A name that only starts like a special one is judged by its extension.
  assert.deepEqual(iconsOf(['readme-check.ts', 'license-check', 'Dockerfile.ts']), {
    'readme-check.ts': 'typescript',
    'license-check': 'file',
    'Dockerfile.ts': 'typescript',
  });
});

test('extensions ignore case and paths, and multi-dot names use their last extension', () => {
  assert.deepEqual(
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
    {
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
    },
  );
  // A file named `test.ts` is TypeScript, not a test of something.
  assert.equal(findFileIcon('test.ts'), 'typescript');
});

test('dotfiles, names without an extension and unknown extensions fall back to a file', () => {
  assert.deepEqual(
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
    {
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
    },
  );
});

test('type marks stand in only for icons chosen by extension, alike across siblings', () => {
  const labelsOf = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, findFileTypeMark(name)?.label ?? null]));
  // A whole name, pattern or test file shows its icon, as in the tree.
  assert.deepEqual(labelsOf(['package.json', 'README.md', 'foo.spec.ts']), {
    'package.json': null,
    'README.md': null,
    'foo.spec.ts': null,
  });
  // Extensions sharing an icon share its mark, or its lack of one.
  assert.deepEqual(labelsOf(['a.ts', 'a.mts', 'a.yml', 'a.yaml', 'a.png']), {
    'a.ts': 'TS',
    'a.mts': 'TS',
    'a.yml': 'YML',
    'a.yaml': 'YML',
    'a.png': null,
  });
  assert.deepEqual(findFileTypeMark('Main.TSX'), { label: 'TSX', hue: 'periwinkle' });
});
