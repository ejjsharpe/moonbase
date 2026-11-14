import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { parseGitStatus } from '../src/host/git-status.ts';

const records = (...rows: string[]) => rows.map((row) => row + '\0').join('');

test('each differing side of a tracked path becomes its own change with its kind', () => {
  assert.deepEqual(
    parseGitStatus(
      records(
        'M  staged.ts',
        ' M unstaged.ts',
        'MM both.ts',
        'A  added.ts',
        'AM added-then-edited.ts',
        'AD added-then-removed.ts',
        'D  removed.ts',
        ' D missing.ts',
        'MD edited-then-removed.ts',
        'T  link.ts',
        ' T replaced.ts',
        ' A intent.ts',
      ),
    ),
    [
      { path: 'staged.ts', area: 'staged', kind: 'modified' },
      { path: 'unstaged.ts', area: 'unstaged', kind: 'modified' },
      { path: 'both.ts', area: 'staged', kind: 'modified' },
      { path: 'both.ts', area: 'unstaged', kind: 'modified' },
      { path: 'added.ts', area: 'staged', kind: 'added' },
      { path: 'added-then-edited.ts', area: 'staged', kind: 'added' },
      { path: 'added-then-edited.ts', area: 'unstaged', kind: 'modified' },
      { path: 'added-then-removed.ts', area: 'staged', kind: 'added' },
      { path: 'added-then-removed.ts', area: 'unstaged', kind: 'deleted' },
      { path: 'removed.ts', area: 'staged', kind: 'deleted' },
      { path: 'missing.ts', area: 'unstaged', kind: 'deleted' },
      { path: 'edited-then-removed.ts', area: 'staged', kind: 'modified' },
      { path: 'edited-then-removed.ts', area: 'unstaged', kind: 'deleted' },
      { path: 'link.ts', area: 'staged', kind: 'typechange' },
      { path: 'replaced.ts', area: 'unstaged', kind: 'typechange' },
      { path: 'intent.ts', area: 'unstaged', kind: 'added' },
    ],
  );
});

test('every unmerged pair is one conflicted change, never a staged and an unstaged one', () => {
  const codes = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
  assert.deepEqual(
    parseGitStatus(records(...codes.map((code) => `${code} ${code}.ts`))),
    codes.map((code) => ({
      path: `${code}.ts`,
      area: 'conflicted',
      kind: 'conflicted',
      // Only a path both sides deleted has no working file to resolve in.
      ...(code === 'DD' && { missing: true }),
    })),
  );
});

test('untracked files are untracked, ignored records are skipped and paths keep their spaces', () => {
  assert.deepEqual(
    parseGitStatus(
      records('?? new folder/a file.ts', '!! ignored.log', ' M  leading space.ts', 'M  tail '),
    ),
    [
      { path: 'new folder/a file.ts', area: 'untracked', kind: 'untracked' },
      { path: ' leading space.ts', area: 'unstaged', kind: 'modified' },
      { path: 'tail ', area: 'staged', kind: 'modified' },
    ],
  );
});

test('a rename or copy lists its target as added and skips the source path record', () => {
  assert.deepEqual(
    parseGitStatus(records('R  new.ts', 'old.ts', 'CM copy.ts', 'source.ts', ' M after.ts')),
    [
      { path: 'new.ts', area: 'staged', kind: 'added' },
      { path: 'copy.ts', area: 'staged', kind: 'added' },
      { path: 'copy.ts', area: 'unstaged', kind: 'modified' },
      { path: 'after.ts', area: 'unstaged', kind: 'modified' },
    ],
  );
});

test('empty output has no changes and malformed records are refused', () => {
  assert.deepEqual(parseGitStatus(''), []);
  for (const output of [records('M'), records('MMfile.ts'), records('X  file.ts')])
    assert.throws(
      () => parseGitStatus(output),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'Unavailable' &&
        error.message.startsWith('Unrecognized Git status record'),
    );
});
