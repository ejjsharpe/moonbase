import { test, expect } from '@playwright/test';
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
} from '../src/editor/files-tree-drop.ts';

const drag = (...paths: string[]): TreeDrag => ({ source: 'editor', checkout: 'checkout', paths });
const into = (folder: string) => ({ source: 'editor', checkout: 'checkout', folder });

test('a drag takes the selection when its row is selected, without entries inside dragged folders', () => {
  expect(selectDraggedPaths('a.ts', ['b.ts', 'c.ts'])).toEqual(['a.ts']);
  expect(selectDraggedPaths('b.ts', ['b.ts', 'c.ts'])).toEqual(['b.ts', 'c.ts']);
  expect(selectDraggedPaths('src', ['src/lib/x.ts', 'src', 'srcs/y.ts', 'src/lib'])).toEqual([
    'src',
    'srcs/y.ts',
  ]);
});

test('a drop lands in a folder row, a file row’s folder, or the root', () => {
  expect(findDropFolder({ path: 'src/lib', directory: true })).toBe('src/lib');
  expect(findDropFolder({ path: 'src/lib/x.ts', directory: false })).toBe('src/lib');
  expect(findDropFolder({ path: 'README.md', directory: false })).toBe('');
  expect(findDropFolder()).toBe('');
});

test('a drop is refused onto or into a dragged entry, where nothing would move, and from elsewhere', () => {
  expect(planDrop(drag('a.ts'), into('src'))).toEqual(['a.ts']);
  expect(planDrop(drag('src/a.ts', 'b.ts'), into(''))).toEqual(['src/a.ts']);
  // Onto a dragged folder or into its descendants, but not a sibling sharing its prefix.
  expect(planDrop(drag('src'), into('src'))).toBeNull();
  expect(planDrop(drag('src', 'a.ts'), into('src/lib'))).toBeNull();
  expect(planDrop(drag('src'), into('srcs'))).toEqual(['src']);
  // Everything already there.
  expect(planDrop(drag('src/a.ts', 'src/b.ts'), into('src'))).toBeNull();
  expect(planDrop(drag('a.ts'), into(''))).toBeNull();
  // Entries already in the folder stay; the rest move.
  expect(planDrop(drag('src/a.ts', 'b.ts', 'docs/c.md'), into('src'))).toEqual([
    'b.ts',
    'docs/c.md',
  ]);
  // Another editor, another checkout, or no drag from a tree at all.
  expect(planDrop(drag('a.ts'), { ...into('src'), source: 'other' })).toBeNull();
  expect(planDrop(drag('a.ts'), { ...into('src'), checkout: 'other' })).toBeNull();
  expect(planDrop(null, into('src'))).toBeNull();
});

test('a drop that would land an entry on another dragged entry is refused', () => {
  // x.ts is already in the root, so a/x.ts would replace the file being dragged with it.
  expect(planDrop(drag('x.ts', 'a/x.ts'), into(''))).toBeNull();
  expect(planDrop(drag('X.ts', 'a/x.ts'), into(''))).toBeNull();
  expect(planDrop(drag('src', 'lib/src'), into(''))).toBeNull();
  expect(planDrop(drag('src/x.ts', 'a/x.ts'), into('src'))).toBeNull();
  // Names that differ, or a dragged entry elsewhere, still drop.
  expect(planDrop(drag('x.ts', 'a/y.ts'), into(''))).toEqual(['a/y.ts']);
  expect(planDrop(drag('src/x.ts', 'a/y.ts'), into('a'))).toEqual(['src/x.ts']);
});

test('a drop is the tree’s own drag only when its DataTransfer names the same one', () => {
  const own = drag('a.ts', 'src');
  expect(isSameDrag(JSON.stringify(own), own)).toBe(true);
  expect(isSameDrag(JSON.stringify({ ...own, source: 'other' }), own)).toBe(false);
  expect(isSameDrag(JSON.stringify({ ...own, checkout: 'other' }), own)).toBe(false);
  expect(isSameDrag(JSON.stringify(drag('a.ts')), own)).toBe(false);
  expect(isSameDrag(JSON.stringify(drag('src', 'a.ts')), own)).toBe(false);
  expect(isSameDrag(JSON.stringify(own), null)).toBe(false);
  for (const data of ['', 'not json', 'null', '[]', '{"paths":"a.ts"}'])
    expect(isSameDrag(data, own)).toBe(false);
});

test('a batch that failed partway transferred only the items it completed', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  expect(listTransferred(paths, { completed: true, items: [] })).toEqual(paths);
  expect(
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
  ).toEqual(['a.ts']);
  expect(listTransferred(paths, { completed: false, items: [] })).toEqual([]);
});

test('the drop region is a folder and its descendants; the root is the whole tree', () => {
  expect(isInDropRegion('src', 'src')).toBe(true);
  expect(isInDropRegion('src/lib/x.ts', 'src')).toBe(true);
  expect(isInDropRegion('srcs', 'src')).toBe(false);
  expect(isInDropRegion('README.md', '')).toBe(false);
  expect(isInDropRegion('src', null)).toBe(false);
});

test('a batch goes to its folder, a single entry to its new path', () => {
  expect(getDropDestination(['a.ts'], 'src')).toBe('src/a.ts');
  expect(getDropDestination(['src/a.ts'], '')).toBe('a.ts');
  expect(getDropDestination(['a.ts', 'docs/b.md'], 'src')).toBe('src');
  expect(getDropDestination(['src/a.ts', 'src/b.ts'], '')).toBe('');
  expect(listDroppedPaths(['a.ts', 'docs/b.md'], 'src')).toEqual(['src/a.ts', 'src/b.md']);
  expect(listDroppedPaths(['src/a.ts'], '')).toEqual(['a.ts']);
  expect(listFoldersToExpand('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
  expect(listFoldersToExpand('')).toEqual([]);
});

test('undo moves each original folder’s entries back together', () => {
  expect(describeUndo({ kind: 'rename', moves: [{ from: 'a', to: 'b', directory: false }] })).toBe(
    'Undo Rename',
  );
  expect(describeUndo({ kind: 'move', moves: [{ from: 'a', to: 'b', directory: false }] })).toBe(
    'Undo Move',
  );
  const moves = [
    { from: 'a.ts', to: 'dest/a.ts', directory: false },
    { from: 'b.ts', to: 'dest/b.ts', directory: false },
    { from: 'docs/c', to: 'dest/c', directory: true },
  ];
  expect(describeUndo({ kind: 'move', moves })).toBe('Undo Move of 3 Items');
  expect(listUndoMoves(moves).map(({ paths, destination }) => ({ paths, destination }))).toEqual([
    { paths: ['dest/a.ts', 'dest/b.ts'], destination: '' },
    { paths: ['dest/c'], destination: 'docs/c' },
  ]);
  expect(
    listUndoMoves([{ from: 'old.ts', to: 'new.ts', directory: false }]).map(
      ({ paths, destination }) => ({ paths, destination }),
    ),
  ).toEqual([{ paths: ['new.ts'], destination: 'old.ts' }]);
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
  expect(findUndoProblem([{ from: 'a.ts', to: 'dest/a.ts', directory: false }], entriesIn)).toBe(
    '',
  );
  expect(findUndoProblem([{ from: 'c', to: 'dest/c', directory: false }], entriesIn)).toContain(
    'dest/c is no longer there',
  );
  expect(
    findUndoProblem([{ from: 'x.ts', to: 'dest/x.ts', directory: false }], entriesIn),
  ).toContain('dest/x.ts is no longer there');
  expect(
    findUndoProblem([{ from: 'taken.ts', to: 'dest/a.ts', directory: false }], entriesIn),
  ).toContain('taken.ts is taken');
  expect(
    findUndoProblem([{ from: 'gone/a.ts', to: 'dest/a.ts', directory: false }], entriesIn),
  ).toContain('the folder gone is gone');
  // A rename that only changed case may go back.
  expect(findUndoProblem([{ from: 'case.ts', to: 'Case.ts', directory: false }], entriesIn)).toBe(
    '',
  );
});
