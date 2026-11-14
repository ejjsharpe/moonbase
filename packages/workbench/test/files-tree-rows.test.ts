import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DirectoryListing } from '@moonbase/contracts/workspace';
import {
  findCreateFolder,
  findShownPath,
  listVisibleRows,
  measureStem,
  placeholderPath,
  selectMountedIndexes,
} from '../src/editor/files-tree/files-tree-rows.ts';

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
  assert.deepEqual(listVisibleRows(listings, checkout, new Set()), [
    { path: 'src', directory: true, level: 1, position: 1, size: 3 },
    { path: 'docs', directory: true, level: 1, position: 2, size: 3 },
    { path: 'README.md', directory: false, ignored: true, level: 1, position: 3, size: 3 },
  ]);
  // A collapsed parent hides an expanded child; an expanded folder without a listing has no rows.
  assert.deepEqual(
    listVisibleRows(listings, checkout, new Set(['src', 'src/lib', 'missing'])).map((row) => [
      row.path,
      row.level,
      row.position,
      row.size,
    ]),
    [
      ['src', 1, 1, 3],
      ['src/lib', 2, 1, 2],
      ['src/lib/util.ts', 3, 1, 1],
      ['src/main.ts', 2, 2, 2],
      ['docs', 1, 2, 3],
      ['README.md', 1, 3, 3],
    ],
  );
  assert.deepEqual(
    listVisibleRows(listings, checkout, new Set(['src/lib'])).map((row) => row.path),
    ['src', 'docs', 'README.md'],
  );
  assert.deepEqual(listVisibleRows({}, checkout, new Set(['src'])), []);
});

test('a placeholder row leads its folder or follows the entry it copies', () => {
  const shape = (rows: ReturnType<typeof listVisibleRows>) =>
    rows.map((row) => [row.path, row.level, row.position, row.size, !!row.placeholder]);
  // First among an expanded folder's children, counted among its siblings.
  assert.deepEqual(
    shape(
      listVisibleRows(listings, checkout, new Set(['src']), { parent: 'src', directory: true }),
    ),
    [
      ['src', 1, 1, 3, false],
      ['src/\0', 2, 1, 3, true],
      ['src/lib', 2, 2, 3, false],
      ['src/main.ts', 2, 3, 3, false],
      ['docs', 1, 2, 3, false],
      ['README.md', 1, 3, 3, false],
    ],
  );
  // Right after a duplicated entry, at the root.
  assert.deepEqual(
    shape(
      listVisibleRows(listings, checkout, new Set(), {
        parent: '',
        directory: false,
        after: 'docs',
      }),
    ),
    [
      ['src', 1, 1, 4, false],
      ['docs', 1, 2, 4, false],
      ['\0', 1, 3, 4, true],
      ['README.md', 1, 4, 4, false],
    ],
  );
  const placeholder = listVisibleRows(listings, checkout, new Set(['docs']), {
    parent: 'docs',
    directory: false,
  })[2];
  assert.deepEqual(placeholder, {
    path: placeholderPath('docs'),
    directory: false,
    placeholder: true,
    level: 2,
    position: 1,
    size: 2,
  });
  // A folder not yet listed shows the placeholder alone; a hidden folder shows none.
  assert.deepEqual(
    shape(
      listVisibleRows(listings, checkout, new Set(['src', 'src/new']), {
        parent: 'src/lib',
        directory: false,
      }),
    ),
    shape(listVisibleRows(listings, checkout, new Set(['src', 'src/new']))),
  );
  assert.deepEqual(
    shape(listVisibleRows({}, checkout, new Set(['src']), { parent: '', directory: false })),
    [['\0', 1, 1, 1, true]],
  );
});

test('hiding ignored entries leaves out them and all they contain', () => {
  const hidden = {
    ...listings,
    [JSON.stringify([checkout, 'src'])]: listing(
      { path: 'src/lib', directory: true, ignored: true },
      { path: 'src/main.ts', directory: false, ignored: false },
    ),
  };
  assert.deepEqual(
    listVisibleRows(hidden, checkout, new Set(['src', 'src/lib']), undefined, true).map((row) => [
      row.path,
      row.position,
      row.size,
    ]),
    [
      ['src', 1, 2],
      ['src/main.ts', 1, 1],
      ['docs', 2, 2],
    ],
  );
  // A hidden path shows at the folder holding its outermost ignored entry.
  assert.equal(findShownPath(hidden, checkout, 'src/lib/util.ts'), 'src');
  assert.equal(findShownPath(hidden, checkout, 'README.md'), '');
  assert.equal(findShownPath(hidden, checkout, 'src/main.ts'), 'src/main.ts');
  assert.equal(findShownPath(hidden, checkout, ''), '');
  assert.equal(findShownPath(hidden, checkout, 'gone/file.ts'), 'gone/file.ts');
});

test('New File starts in the focused folder, a focused file’s folder, or the root', () => {
  assert.equal(findCreateFolder(listings, checkout, 'src/lib'), 'src/lib');
  assert.equal(findCreateFolder(listings, checkout, 'src/lib/util.ts'), 'src/lib');
  assert.equal(findCreateFolder(listings, checkout, 'README.md'), '');
  assert.equal(findCreateFolder(listings, checkout, ''), '');
  assert.equal(findCreateFolder(listings, checkout, 'gone/file.ts'), '');
  assert.equal(findCreateFolder(listings, 'other', 'src'), '');
});

test('a name’s stem leaves out its extension, except for folders and dotfiles', () => {
  assert.equal(measureStem('index.test.ts', false), 'index.test'.length);
  assert.equal(measureStem('README', false), 6);
  assert.equal(measureStem('.gitignore', false), 10);
  assert.equal(measureStem('lib.v2', true), 6);
  assert.equal(measureStem('', false), 0);
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
  assert.deepEqual(
    selectMountedIndexes({ rows, top: 1400, height: 280, focusIndex: 55 }),
    range(40, 70),
  );
  assert.deepEqual(
    selectMountedIndexes({
      rows,
      top: 1400,
      height: 280,
      focusIndex: 3,
      pinnedPaths: ['file-199', 'file-60', 'not-a-row'],
    }),
    [3, ...range(40, 70), 199],
  );
  assert.deepEqual(selectMountedIndexes({ rows: [], top: 0, height: 500, focusIndex: 0 }), []);
});
