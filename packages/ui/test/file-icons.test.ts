import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFileIcon, findFileTypeMark } from '@moonbase/ui/file-icons';

// The tables themselves are the design; these cases check how a name is matched against them.
const sameIcon = (name: string, as: string) =>
  assert.equal(findFileIcon(name), findFileIcon(as), name);

test('whole names take their own icon before their extension', () => {
  assert.notEqual(findFileIcon('package.json'), findFileIcon('data.json'));
  sameIcon('PACKAGE.JSON', 'package.json');
  sameIcon('LICENSE-MIT', 'LICENSE');
  sameIcon('.env.local', '.env');
  sameIcon('Dockerfile.dev', 'Dockerfile');
  assert.notEqual(findFileIcon('Dockerfile'), 'file');
  // A name that only starts like a special one is judged by its extension.
  sameIcon('Dockerfile.ts', 'main.ts');
  sameIcon('readme-check.ts', 'main.ts');
  assert.equal(findFileIcon('license-check'), 'file');
});

test('extensions ignore case and paths, and multi-dot names use their last extension', () => {
  sameIcon('MAIN.TS', 'main.ts');
  sameIcon('src/lib/Util.Tsx', 'view.tsx');
  // Only the base name counts, not a dotted folder above it.
  assert.equal(findFileIcon('a.lock/b'), 'file');
  sameIcon('archive.tar.gz', 'archive.gz');
  // Script tests have their own icon; other files and a file named `test.ts` keep theirs.
  sameIcon('util.test.tsx', 'files-tree.spec.ts');
  assert.notEqual(findFileIcon('util.test.tsx'), findFileIcon('util.tsx'));
  sameIcon('notes.test.md', 'notes.md');
  sameIcon('test.ts', 'main.ts');
});

test('dotfiles, names without an extension and unknown extensions fall back to a file', () => {
  // A dotfile's leading dot is part of its name, not an extension.
  sameIcon('.hidden.ts', 'main.ts');
  for (const name of ['.hidden', 'LICENSES', 'notes', 'data.xyz', 'odd.', ''])
    assert.equal(findFileIcon(name), 'file', name);
});

test('type marks stand in only for icons chosen by extension, alike across siblings', () => {
  // A whole name, pattern or test file shows its icon, as in the tree.
  for (const name of ['package.json', 'README.md', 'foo.spec.ts'])
    assert.equal(findFileTypeMark(name), null, name);
  // Extensions sharing an icon share its mark, or its lack of one, unless one has its own.
  assert(findFileTypeMark('a.ts'));
  assert.deepEqual(findFileTypeMark('a.mts'), findFileTypeMark('a.ts'));
  assert.deepEqual(findFileTypeMark('Main.TSX'), findFileTypeMark('a.tsx'));
  assert.equal(findFileTypeMark('a.png'), null);
  sameIcon('a.jsx', 'a.tsx');
  assert.notDeepEqual(findFileTypeMark('a.jsx'), findFileTypeMark('a.tsx'));
});
