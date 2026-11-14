import type { GitChange, GitChangeKind } from '@moonbase/contracts/workspace';

/** Kinds from strongest to weakest: a folder shows its strongest descendant's. */
const kindStrength: readonly GitChangeKind[] = [
  'conflicted',
  'deleted',
  'modified',
  'typechange',
  'added',
  'untracked',
];

/** Each kind's letter mark and the words appended to a row's accessible name. */
export const gitStatusMarks: Readonly<Record<GitChangeKind, { letter: string; label: string }>> = {
  conflicted: { letter: '!', label: 'conflicted' },
  deleted: { letter: 'D', label: 'deleted' },
  modified: { letter: 'M', label: 'modified' },
  typechange: { letter: 'T', label: 'type changed' },
  added: { letter: 'A', label: 'added' },
  untracked: { letter: 'U', label: 'untracked' },
};

/** The stronger of two kinds; `undefined` loses to any kind. */
export function selectStrongerKind(current: GitChangeKind | undefined, next: GitChangeKind) {
  return current && kindStrength.indexOf(current) <= kindStrength.indexOf(next) ? current : next;
}

/**
 * What happened to one path, from its kind in each area: the strongest, except that a new file
 * edited since it was staged is still added, and one untracked by `git rm --cached` (staged
 * deleted, yet on disk) is untracked.
 */
function describePathChange(kinds: Partial<Record<GitChange['area'], GitChangeKind>>) {
  const { staged, unstaged, untracked } = kinds;
  if (staged === 'added' && unstaged && unstaged !== 'deleted') return 'added';
  if (staged === 'deleted' && untracked) return untracked;
  let strongest: GitChangeKind | undefined;
  for (const kind of Object.values(kinds)) strongest = selectStrongerKind(strongest, kind);
  return strongest;
}

/**
 * Each changed path's kind (see `describePathChange`), and each folder above a changed path with
 * its strongest descendant's kind.
 */
export function rollUpGitStatus(changes: readonly GitChange[]) {
  const areas = new Map<string, Partial<Record<GitChange['area'], GitChangeKind>>>();
  for (const { path, area, kind } of changes) areas.set(path, { ...areas.get(path), [area]: kind });
  const kinds = new Map<string, GitChangeKind>();
  for (const [path, pathKinds] of areas) {
    const kind = describePathChange(pathKinds);
    if (!kind) continue;
    kinds.set(path, kind);
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
      const folder = path.slice(0, end),
        stronger = selectStrongerKind(kinds.get(folder), kind);
      // An ancestor already this strong means every folder above it is too.
      if (stronger === kinds.get(folder)) break;
      kinds.set(folder, stronger);
    }
  }
  return kinds;
}
