import { test, expect } from '@playwright/test';
import {
  copyName,
  findFreeName,
  findPasteFolder,
  planPaste,
} from '../src/editor/file-clipboard.ts';

const file = (path: string) => ({ path, directory: false });
const folder = (path: string) => ({ path, directory: true });
const taken = (...names: string[]) => new Set(names.map((name) => name.toLowerCase()));

test('a copy is named like a duplicate, then numbered, keeping a file’s extension', () => {
  expect(copyName('a.ts', false)).toBe('a copy.ts');
  expect(copyName('a.ts', false, 2)).toBe('a copy 2.ts');
  expect(copyName('.env', false)).toBe('.env copy');
  expect(copyName('lib.v2', true, 3)).toBe('lib.v2 copy 3');
  expect(findFreeName('a.ts', false, taken('a.ts'))).toBe('a copy.ts');
  expect(findFreeName('a.ts', false, taken('a.ts', 'a copy.ts', 'a copy 2.ts'))).toBe(
    'a copy 3.ts',
  );
  // Names fold as the workspace compares them.
  expect(findFreeName('A.ts', false, taken('a copy.ts'))).toBe('A copy 2.ts');
  expect(findFreeName('e\u0301.ts', false, new Set(['\u00e9 copy.ts']))).toBe('e\u0301 copy 2.ts');
});

test('a folder pasted onto itself lands beside it', () => {
  expect(findPasteFolder(['src'], 'src')).toBe('');
  expect(findPasteFolder(['src/lib'], 'src/lib')).toBe('src');
  expect(findPasteFolder(['src'], 'docs')).toBe('docs');
  expect(findPasteFolder(['src'], 'src/lib')).toBe('src/lib');
});

test('a copy keeps free names and picks copy names for the rest', () => {
  expect(planPaste('copy', [file('a.ts'), file('src/b.ts')], 'dest', [file('dest/c.ts')])).toEqual({
    kind: 'copy',
    paths: ['a.ts', 'src/b.ts'],
    renamed: [],
  });
  // Into its own folder, every entry collides with itself.
  expect(planPaste('copy', [file('a.ts')], '', [file('a.ts'), file('a copy.ts')])).toEqual({
    kind: 'copy',
    paths: [],
    renamed: [{ path: 'a.ts', name: 'a copy 2.ts' }],
  });
  expect(
    planPaste('copy', [file('README.md'), file('welcome.ts'), folder('lib')], 'dest', [
      file('dest/readme.md'),
      folder('dest/lib'),
    ]),
  ).toEqual({
    kind: 'copy',
    paths: ['welcome.ts'],
    renamed: [
      { path: 'README.md', name: 'README copy.md' },
      { path: 'lib', name: 'lib copy' },
    ],
  });
  // Entries with one name from different folders, and a copy name another entry already has.
  expect(
    planPaste('copy', [file('x/a.ts'), file('y/a.ts'), file('z/a copy.ts')], 'dest', []),
  ).toEqual({
    kind: 'copy',
    paths: ['x/a.ts', 'z/a copy.ts'],
    renamed: [{ path: 'y/a.ts', name: 'a copy 2.ts' }],
  });
  expect(planPaste('copy', [folder('src')], 'src/lib', [])).toEqual({
    kind: 'refused',
    message: 'Can’t copy a folder into itself.',
  });
});

test('a cut moves as a drop does, refusing a move into itself or onto another cut entry', () => {
  expect(planPaste('cut', [file('a.ts'), file('dest/b.ts')], 'dest', [file('dest/b.ts')])).toEqual({
    kind: 'move',
    paths: ['a.ts'],
  });
  expect(planPaste('cut', [file('dest/b.ts')], 'dest', [file('dest/b.ts')])).toEqual({
    kind: 'none',
  });
  expect(planPaste('cut', [folder('src')], 'src/lib', [])).toEqual({
    kind: 'refused',
    message: 'Can’t move a folder into itself.',
  });
  for (const sources of [
    [file('x/a.ts'), file('y/A.ts')],
    [file('a.ts'), file('dest/a.ts')],
  ])
    expect(planPaste('cut', sources, 'dest', [])).toEqual({
      kind: 'refused',
      message: 'Cut items with the same name can’t go into one folder.',
    });
});
