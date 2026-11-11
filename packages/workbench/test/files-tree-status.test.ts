import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitChange } from '@moonbase/contracts/workspace';
import { rollUpGitStatus, selectStrongerKind } from '../src/editor/files-tree-status.ts';

test('a path shows its strongest kind and each folder its strongest descendant', () => {
  const changes: GitChange[] = [
    { path: 'README.md', area: 'untracked', kind: 'untracked' },
    { path: 'src/lib/util.ts', area: 'staged', kind: 'added' },
    { path: 'src/lib/util.ts', area: 'unstaged', kind: 'modified' },
    { path: 'src/main.ts', area: 'unstaged', kind: 'typechange' },
    { path: 'docs/a/b/old.md', area: 'staged', kind: 'deleted' },
    { path: 'docs/new.md', area: 'untracked', kind: 'untracked' },
    { path: 'merge/x.ts', area: 'untracked', kind: 'untracked' },
    { path: 'merge/y.ts', area: 'conflicted', kind: 'conflicted' },
  ];
  assert.deepEqual(Object.fromEntries(rollUpGitStatus(changes)), {
    'README.md': 'untracked',
    // A new file edited since it was staged is still added.
    'src/lib/util.ts': 'added',
    'src/lib': 'added',
    src: 'typechange',
    'src/main.ts': 'typechange',
    'docs/a/b/old.md': 'deleted',
    'docs/a/b': 'deleted',
    'docs/a': 'deleted',
    docs: 'deleted',
    'docs/new.md': 'untracked',
    'merge/x.ts': 'untracked',
    'merge/y.ts': 'conflicted',
    merge: 'conflicted',
  });
  // Order does not matter: a weaker change below a stronger folder leaves it as it is.
  assert.deepEqual(
    Object.fromEntries(rollUpGitStatus([...changes].reverse())),
    Object.fromEntries(rollUpGitStatus(changes)),
  );
  assert.equal(rollUpGitStatus([]).size, 0);
});

test('a path staged and unstaged shows what happened to it, else its strongest kind', () => {
  const change = (path: string, area: GitChange['area'], kind: GitChange['kind']): GitChange => ({
    path,
    area,
    kind,
  });
  const changes: GitChange[] = [
    change('am.ts', 'staged', 'added'),
    change('am.ts', 'unstaged', 'modified'),
    // `git rm --cached`: deleted from the index, still on disk.
    change('cached.ts', 'staged', 'deleted'),
    change('cached.ts', 'untracked', 'untracked'),
    // Added, then removed from disk: gone.
    change('ad.ts', 'staged', 'added'),
    change('ad.ts', 'unstaged', 'deleted'),
    change('md.ts', 'staged', 'modified'),
    change('md.ts', 'unstaged', 'deleted'),
    change('mm.ts', 'staged', 'modified'),
    change('mm.ts', 'unstaged', 'modified'),
    change('mt.ts', 'staged', 'modified'),
    change('mt.ts', 'unstaged', 'typechange'),
  ];
  const kinds = rollUpGitStatus(changes);
  assert.deepEqual(Object.fromEntries(kinds), {
    'am.ts': 'added',
    'cached.ts': 'untracked',
    'ad.ts': 'deleted',
    'md.ts': 'deleted',
    'mm.ts': 'modified',
    'mt.ts': 'modified',
  });
  assert.deepEqual(rollUpGitStatus([...changes].reverse()), kinds);
  // Folders still take the strongest of their descendants' kinds.
  assert.equal(
    rollUpGitStatus([
      change('a/am.ts', 'staged', 'added'),
      change('a/am.ts', 'unstaged', 'modified'),
      change('a/cached.ts', 'staged', 'deleted'),
      change('a/cached.ts', 'untracked', 'untracked'),
    ]).get('a'),
    'added',
  );
});

test('kinds rank conflicted, deleted, modified, typechange, added, then untracked', () => {
  const ranked = ['conflicted', 'deleted', 'modified', 'typechange', 'added', 'untracked'] as const;
  ranked.forEach((stronger, index) => {
    assert.equal(selectStrongerKind(undefined, stronger), stronger);
    for (const weaker of ranked.slice(index)) {
      assert.equal(selectStrongerKind(stronger, weaker), stronger);
      assert.equal(selectStrongerKind(weaker, stronger), stronger);
    }
  });
});
