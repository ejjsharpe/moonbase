import { test, expect } from '@playwright/test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';
import { listVisibleRows, selectMountedIndexes } from '../src/editor/files-tree-rows.ts';

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
