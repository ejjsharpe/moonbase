import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DirectoryEntry } from '@moonbase/contracts/workspace';
import {
  describeUndo,
  findDropFolder,
  findUndoProblem,
  getDropDestination,
  isInDropRegion,
  isSameDrag,
  listDroppedPaths,
  listFoldersToExpand,
  listTransferred,
  listUndoMoves,
  planDrop,
  selectDraggedPaths,
  type TreeDrag,
} from '../src/files-tree/files-tree-drop.ts';

const drag = (...paths: string[]): TreeDrag => ({ source: 'editor', checkout: 'checkout', paths });
const into = (folder: string) => ({ source: 'editor', checkout: 'checkout', folder });

test('a drag takes the selection when its row is selected, without entries inside dragged folders', () => {
  assert.deepEqual(selectDraggedPaths('a.ts', ['b.ts', 'c.ts']), ['a.ts']);
  assert.deepEqual(selectDraggedPaths('b.ts', ['b.ts', 'c.ts']), ['b.ts', 'c.ts']);
  assert.deepEqual(selectDraggedPaths('src', ['src/lib/x.ts', 'src', 'srcs/y.ts', 'src/lib']), [
    'src',
    'srcs/y.ts',
  ]);
});

test('a drop lands in a folder row, a file row’s folder, or the root', () => {
  assert.equal(findDropFolder({ path: 'src/lib', directory: true }), 'src/lib');
  assert.equal(findDropFolder({ path: 'src/lib/x.ts', directory: false }), 'src/lib');
  assert.equal(findDropFolder({ path: 'README.md', directory: false }), '');
  assert.equal(findDropFolder(), '');
});

test('a drop is refused onto or into a dragged entry, where nothing would move, and from elsewhere', () => {
  assert.deepEqual(planDrop(drag('a.ts'), into('src')), ['a.ts']);
  assert.deepEqual(planDrop(drag('src/a.ts', 'b.ts'), into('')), ['src/a.ts']);
  // Onto a dragged folder or into its descendants, but not a sibling sharing its prefix.
  assert.equal(planDrop(drag('src'), into('src')), null);
  assert.equal(planDrop(drag('src', 'a.ts'), into('src/lib')), null);
  assert.deepEqual(planDrop(drag('src'), into('srcs')), ['src']);
  // Everything already there.
  assert.equal(planDrop(drag('src/a.ts', 'src/b.ts'), into('src')), null);
  assert.equal(planDrop(drag('a.ts'), into('')), null);
  // Entries already in the folder stay; the rest move.
  assert.deepEqual(planDrop(drag('src/a.ts', 'b.ts', 'docs/c.md'), into('src')), [
    'b.ts',
    'docs/c.md',
  ]);
  // Two entries landing on one name.
  assert.equal(planDrop(drag('x/a.ts', 'y/A.ts'), into('src')), null);
  // Another editor, another checkout, or no drag from a tree at all.
  assert.equal(planDrop(drag('a.ts'), { ...into('src'), source: 'other' }), null);
  assert.equal(planDrop(drag('a.ts'), { ...into('src'), checkout: 'other' }), null);
  assert.equal(planDrop(null, into('src')), null);
});

test('a drop that would land an entry on another dragged entry is refused', () => {
  // x.ts is already in the root, so a/x.ts would replace the file being dragged with it.
  assert.equal(planDrop(drag('x.ts', 'a/x.ts'), into('')), null);
  assert.equal(planDrop(drag('X.ts', 'a/x.ts'), into('')), null);
  assert.equal(planDrop(drag('src', 'lib/src'), into('')), null);
  assert.equal(planDrop(drag('src/x.ts', 'a/x.ts'), into('src')), null);
  // Names that differ, or a dragged entry elsewhere, still drop.
  assert.deepEqual(planDrop(drag('x.ts', 'a/y.ts'), into('')), ['a/y.ts']);
  assert.deepEqual(planDrop(drag('src/x.ts', 'a/y.ts'), into('a')), ['src/x.ts']);
});

test('a drop is the tree’s own drag only when its DataTransfer names the same one', () => {
  const own = drag('a.ts', 'src');
  assert.equal(isSameDrag(JSON.stringify(own), own), true);
  assert.equal(isSameDrag(JSON.stringify({ ...own, source: 'other' }), own), false);
  assert.equal(isSameDrag(JSON.stringify({ ...own, checkout: 'other' }), own), false);
  assert.equal(isSameDrag(JSON.stringify(drag('a.ts')), own), false);
  assert.equal(isSameDrag(JSON.stringify(drag('src', 'a.ts')), own), false);
  assert.equal(isSameDrag(JSON.stringify(own), null), false);
  for (const data of ['', 'not json', 'null', '[]', '{"paths":"a.ts"}'])
    assert.equal(isSameDrag(data, own), false);
});

test('a batch that failed partway transferred only the items it completed', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  assert.deepEqual(listTransferred(paths, { completed: true, items: [] }), paths);
  assert.deepEqual(
    listTransferred(paths, {
      completed: false,
      items: [
        // A replaced entry, which moved to the Trash.
        { source: 'dest/a.ts', outcome: 'completed' },
        { source: 'a.ts', destination: 'dest/a.ts', outcome: 'completed' },
        { source: 'b.ts', destination: 'dest/b.ts', outcome: 'failed', message: 'Busy' },
        { source: 'c.ts', destination: 'dest/c.ts', outcome: 'uncertain' },
      ],
    }),
    ['a.ts'],
  );
  assert.deepEqual(listTransferred(paths, { completed: false, items: [] }), []);
});

test('the drop region is a folder and its descendants; the root is the whole tree', () => {
  assert.equal(isInDropRegion('src', 'src'), true);
  assert.equal(isInDropRegion('src/lib/x.ts', 'src'), true);
  assert.equal(isInDropRegion('srcs', 'src'), false);
  assert.equal(isInDropRegion('README.md', ''), false);
  assert.equal(isInDropRegion('src', null), false);
});

test('a batch goes to its folder, a single entry to its new path', () => {
  assert.equal(getDropDestination(['a.ts'], 'src'), 'src/a.ts');
  assert.equal(getDropDestination(['src/a.ts'], ''), 'a.ts');
  assert.equal(getDropDestination(['a.ts', 'docs/b.md'], 'src'), 'src');
  assert.equal(getDropDestination(['src/a.ts', 'src/b.ts'], ''), '');
  assert.deepEqual(listDroppedPaths(['a.ts', 'docs/b.md'], 'src'), ['src/a.ts', 'src/b.md']);
  assert.deepEqual(listDroppedPaths(['src/a.ts'], ''), ['a.ts']);
  assert.deepEqual(listFoldersToExpand('a/b/c'), ['a', 'a/b', 'a/b/c']);
  assert.deepEqual(listFoldersToExpand(''), []);
});

test('undo moves each original folder’s entries back together', () => {
  assert.equal(
    describeUndo({ kind: 'rename', moves: [{ from: 'a', to: 'b', directory: false }] }),
    'Undo Rename',
  );
  assert.equal(
    describeUndo({ kind: 'move', moves: [{ from: 'a', to: 'b', directory: false }] }),
    'Undo Move',
  );
  const moves = [
    { from: 'a.ts', to: 'dest/a.ts', directory: false },
    { from: 'b.ts', to: 'dest/b.ts', directory: false },
    { from: 'docs/c', to: 'dest/c', directory: true },
  ];
  assert.equal(describeUndo({ kind: 'move', moves }), 'Undo Move of 3 Items');
  assert.deepEqual(
    listUndoMoves(moves).map(({ paths, destination }) => ({ paths, destination })),
    [
      { paths: ['dest/a.ts', 'dest/b.ts'], destination: '' },
      { paths: ['dest/c'], destination: 'docs/c' },
    ],
  );
  assert.deepEqual(
    listUndoMoves([{ from: 'old.ts', to: 'new.ts', directory: false }]).map(
      ({ paths, destination }) => ({ paths, destination }),
    ),
    [{ paths: ['new.ts'], destination: 'old.ts' }],
  );
});

test('undo is refused when a moved entry has gone or its original path is taken', () => {
  const listings: Record<string, DirectoryEntry[]> = {
    '': [
      { path: 'dest', directory: true },
      { path: 'Taken.ts', directory: false },
      { path: 'Case.ts', directory: false },
    ],
    dest: [
      { path: 'dest/a.ts', directory: false },
      { path: 'dest/c', directory: true },
    ],
  };
  const entriesIn = (folder: string) => listings[folder];
  assert.equal(
    findUndoProblem([{ from: 'a.ts', to: 'dest/a.ts', directory: false }], entriesIn),
    '',
  );
  assert.ok(
    findUndoProblem([{ from: 'c', to: 'dest/c', directory: false }], entriesIn)?.includes(
      'dest/c is no longer there',
    ),
  );
  assert.ok(
    findUndoProblem([{ from: 'x.ts', to: 'dest/x.ts', directory: false }], entriesIn)?.includes(
      'dest/x.ts is no longer there',
    ),
  );
  assert.ok(
    findUndoProblem([{ from: 'taken.ts', to: 'dest/a.ts', directory: false }], entriesIn)?.includes(
      'taken.ts is taken',
    ),
  );
  assert.ok(
    findUndoProblem(
      [{ from: 'gone/a.ts', to: 'dest/a.ts', directory: false }],
      entriesIn,
    )?.includes('the folder gone is gone'),
  );
  // A rename that only changed case may go back.
  assert.equal(
    findUndoProblem([{ from: 'case.ts', to: 'Case.ts', directory: false }], entriesIn),
    '',
  );
});
