import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyName, findFreeName, findPasteFolder, planPaste } from './file-clipboard.ts';

const file = (path: string) => ({ path, directory: false });
const folder = (path: string) => ({ path, directory: true });
const taken = (...names: string[]) => new Set(names.map((name) => name.toLowerCase()));

test('a copy is named like a duplicate, then numbered, keeping a file’s extension', () => {
  assert.equal(copyName('a.ts', false), 'a copy.ts');
  assert.equal(copyName('a.ts', false, 2), 'a copy 2.ts');
  assert.equal(copyName('.env', false), '.env copy');
  assert.equal(copyName('lib.v2', true, 3), 'lib.v2 copy 3');
  assert.equal(findFreeName('a.ts', false, taken('a.ts')), 'a copy.ts');
  assert.equal(
    findFreeName('a.ts', false, taken('a.ts', 'a copy.ts', 'a copy 2.ts')),
    'a copy 3.ts',
  );
  // Names fold as the workspace compares them.
  assert.equal(findFreeName('A.ts', false, taken('a copy.ts')), 'A copy 2.ts');
  assert.equal(findFreeName('e\u0301.ts', false, new Set(['\u00e9 copy.ts'])), 'e\u0301 copy 2.ts');
});

test('a copied folder pasted onto itself lands beside it; a cut one stays to be refused', () => {
  assert.equal(findPasteFolder('copy', ['src'], 'src'), '');
  assert.equal(findPasteFolder('copy', ['src/lib'], 'src/lib'), 'src');
  assert.equal(findPasteFolder('copy', ['src'], 'docs'), 'docs');
  assert.equal(findPasteFolder('copy', ['src'], 'src/lib'), 'src/lib');
  assert.equal(findPasteFolder('cut', ['src', 'a.ts'], 'src'), 'src');
  assert.deepEqual(planPaste('cut', [folder('src'), file('a.ts')], 'src', []), {
    kind: 'refused',
    message: 'Can’t move a folder into itself.',
  });
});

test('a copy keeps free names and picks copy names for the rest', () => {
  assert.deepEqual(
    planPaste('copy', [file('a.ts'), file('src/b.ts')], 'dest', [file('dest/c.ts')]),
    {
      kind: 'copy',
      paths: ['a.ts', 'src/b.ts'],
      renamed: [],
    },
  );
  // Into its own folder, every entry collides with itself.
  assert.deepEqual(planPaste('copy', [file('a.ts')], '', [file('a.ts'), file('a copy.ts')]), {
    kind: 'copy',
    paths: [],
    renamed: [{ path: 'a.ts', name: 'a copy 2.ts' }],
  });
  assert.deepEqual(
    planPaste('copy', [file('README.md'), file('welcome.ts'), folder('lib')], 'dest', [
      file('dest/readme.md'),
      folder('dest/lib'),
    ]),
    {
      kind: 'copy',
      paths: ['welcome.ts'],
      renamed: [
        { path: 'README.md', name: 'README copy.md' },
        { path: 'lib', name: 'lib copy' },
      ],
    },
  );
  // Entries with one name from different folders, and a copy name another entry already has.
  assert.deepEqual(
    planPaste('copy', [file('x/a.ts'), file('y/a.ts'), file('z/a copy.ts')], 'dest', []),
    {
      kind: 'copy',
      paths: ['x/a.ts', 'z/a copy.ts'],
      renamed: [{ path: 'y/a.ts', name: 'a copy 2.ts' }],
    },
  );
  assert.deepEqual(planPaste('copy', [folder('src')], 'src/lib', []), {
    kind: 'refused',
    message: 'Can’t copy a folder into itself.',
  });
});

test('a cut moves as a drop does, refusing a move into itself or onto another cut entry', () => {
  assert.deepEqual(
    planPaste('cut', [file('a.ts'), file('dest/b.ts')], 'dest', [file('dest/b.ts')]),
    {
      kind: 'move',
      paths: ['a.ts'],
    },
  );
  assert.deepEqual(planPaste('cut', [file('dest/b.ts')], 'dest', [file('dest/b.ts')]), {
    kind: 'none',
  });
  assert.deepEqual(planPaste('cut', [folder('src')], 'src/lib', []), {
    kind: 'refused',
    message: 'Can’t move a folder into itself.',
  });
  for (const sources of [
    [file('x/a.ts'), file('y/A.ts')],
    [file('a.ts'), file('dest/a.ts')],
  ])
    assert.deepEqual(planPaste('cut', sources, 'dest', []), {
      kind: 'refused',
      message: 'Cut items with the same name can’t go into one folder.',
    });
});
