import { test, expect } from '@playwright/test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';
import {
  findCreateFolder,
  listVisibleRows,
  measureStem,
  placeholderPath,
  selectMountedIndexes,
} from '../src/editor/files-tree-rows.ts';

const checkout = 'checkout';
const listing = (...entries: DirectoryListing['entries']): DirectoryListing => ({
  entries,
  partial: false,
});
const listings: Record<string, DirectoryListing> = {
  [JSON.stringify([checkout, ''])]: listing(
    { path: 'src', directory: true },
    { path: 'docs', directory: true },
    { path: 'README.md', directory: false, ignored: true },
  ),
  [JSON.stringify([checkout, 'src'])]: listing(
    { path: 'src/lib', directory: true },
    { path: 'src/main.ts', directory: false },
  ),
  [JSON.stringify([checkout, 'src/lib'])]: listing({ path: 'src/lib/util.ts', directory: false }),
  [JSON.stringify([checkout, 'docs'])]: listing({ path: 'docs/guide.md', directory: false }),
  [JSON.stringify(['other', ''])]: listing({ path: 'elsewhere.ts', directory: false }),
};

test('visible rows descend only into expanded folders that are listed', () => {
  expect(listVisibleRows(listings, checkout, new Set())).toEqual([
    { path: 'src', directory: true, level: 1, position: 1, size: 3 },
    { path: 'docs', directory: true, level: 1, position: 2, size: 3 },
    { path: 'README.md', directory: false, ignored: true, level: 1, position: 3, size: 3 },
  ]);
  // A collapsed parent hides an expanded child; an expanded folder without a listing has no rows.
  expect(
    listVisibleRows(listings, checkout, new Set(['src', 'src/lib', 'missing'])).map((row) => [
      row.path,
      row.level,
      row.position,
      row.size,
    ]),
  ).toEqual([
    ['src', 1, 1, 3],
    ['src/lib', 2, 1, 2],
    ['src/lib/util.ts', 3, 1, 1],
    ['src/main.ts', 2, 2, 2],
    ['docs', 1, 2, 3],
    ['README.md', 1, 3, 3],
  ]);
  expect(listVisibleRows(listings, checkout, new Set(['src/lib'])).map((row) => row.path)).toEqual([
    'src',
    'docs',
    'README.md',
  ]);
  expect(listVisibleRows({}, checkout, new Set(['src']))).toEqual([]);
});

test('a placeholder row leads its folder or follows the entry it copies', () => {
  const shape = (rows: ReturnType<typeof listVisibleRows>) =>
    rows.map((row) => [row.path, row.level, row.position, row.size, !!row.placeholder]);
  // First among an expanded folder's children, counted among its siblings.
  expect(
    shape(
      listVisibleRows(listings, checkout, new Set(['src']), { parent: 'src', directory: true }),
    ),
  ).toEqual([
    ['src', 1, 1, 3, false],
    ['src/\0', 2, 1, 3, true],
    ['src/lib', 2, 2, 3, false],
    ['src/main.ts', 2, 3, 3, false],
    ['docs', 1, 2, 3, false],
    ['README.md', 1, 3, 3, false],
  ]);
  // Right after a duplicated entry, at the root.
  expect(
    shape(
      listVisibleRows(listings, checkout, new Set(), {
        parent: '',
        directory: false,
        after: 'docs',
      }),
    ),
  ).toEqual([
    ['src', 1, 1, 4, false],
    ['docs', 1, 2, 4, false],
    ['\0', 1, 3, 4, true],
    ['README.md', 1, 4, 4, false],
  ]);
  const placeholder = listVisibleRows(listings, checkout, new Set(['docs']), {
    parent: 'docs',
    directory: false,
  })[2];
  expect(placeholder).toEqual({
    path: placeholderPath('docs'),
    directory: false,
    placeholder: true,
    level: 2,
    position: 1,
    size: 2,
  });
  // A folder not yet listed shows the placeholder alone; a hidden folder shows none.
  expect(
    shape(
      listVisibleRows(listings, checkout, new Set(['src', 'src/new']), {
        parent: 'src/lib',
        directory: false,
      }),
    ),
  ).toEqual(shape(listVisibleRows(listings, checkout, new Set(['src', 'src/new']))));
  expect(
    shape(listVisibleRows({}, checkout, new Set(['src']), { parent: '', directory: false })),
  ).toEqual([['\0', 1, 1, 1, true]]);
});

test('New File starts in the focused folder, a focused file’s folder, or the root', () => {
  expect(findCreateFolder(listings, checkout, 'src/lib')).toBe('src/lib');
  expect(findCreateFolder(listings, checkout, 'src/lib/util.ts')).toBe('src/lib');
  expect(findCreateFolder(listings, checkout, 'README.md')).toBe('');
  expect(findCreateFolder(listings, checkout, '')).toBe('');
  expect(findCreateFolder(listings, checkout, 'gone/file.ts')).toBe('');
  expect(findCreateFolder(listings, 'other', 'src')).toBe('');
});

test('a name’s stem leaves out its extension, except for folders and dotfiles', () => {
  expect(measureStem('index.test.ts', false)).toBe('index.test'.length);
  expect(measureStem('README', false)).toBe(6);
  expect(measureStem('.gitignore', false)).toBe(10);
  expect(measureStem('lib.v2', true)).toBe(6);
  expect(measureStem('', false)).toBe(0);
});

test('mounted rows cover the scrolled window, the focused row and pinned rows', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    path: `file-${index}`,
    directory: false,
    level: 1,
    position: index + 1,
    size: 200,
  }));
  const range = (start: number, end: number) =>
    Array.from({ length: end - start }, (_, index) => start + index);
  // 28px rows: 1400px down shows rows 50–60, with ten more mounted on each side.
  expect(selectMountedIndexes({ rows, top: 1400, height: 280, focusIndex: 55 })).toEqual(
    range(40, 70),
  );
  expect(
    selectMountedIndexes({
      rows,
      top: 1400,
      height: 280,
      focusIndex: 3,
      pinnedPaths: ['file-199', 'file-60', 'not-a-row'],
    }),
  ).toEqual([3, ...range(40, 70), 199]);
  expect(selectMountedIndexes({ rows: [], top: 0, height: 500, focusIndex: 0 })).toEqual([]);
});
