import { test, expect } from '@playwright/test';
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
  expect(Object.fromEntries(rollUpGitStatus(changes))).toEqual({
    'README.md': 'untracked',
    'src/lib/util.ts': 'modified',
    'src/lib': 'modified',
    src: 'modified',
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
  expect(Object.fromEntries(rollUpGitStatus([...changes].reverse()))).toEqual(
    Object.fromEntries(rollUpGitStatus(changes)),
  );
  expect(rollUpGitStatus([]).size).toBe(0);
});

test('kinds rank conflicted, deleted, modified, typechange, added, then untracked', () => {
  const ranked = ['conflicted', 'deleted', 'modified', 'typechange', 'added', 'untracked'] as const;
  ranked.forEach((stronger, index) => {
    expect(selectStrongerKind(undefined, stronger)).toBe(stronger);
    for (const weaker of ranked.slice(index)) {
      expect(selectStrongerKind(stronger, weaker)).toBe(stronger);
      expect(selectStrongerKind(weaker, stronger)).toBe(stronger);
    }
  });
});
