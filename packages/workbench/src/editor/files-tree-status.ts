import type { GitChange, GitChangeKind } from '@moonbase/contracts/workspace';

/** Kinds from strongest to weakest: a path changed in several ways shows the strongest. */
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
 * Each changed path's strongest kind across its staged and unstaged entries, and each folder
 * above a changed path with its strongest descendant's kind.
 */
export function rollUpGitStatus(changes: readonly GitChange[]) {
  const kinds = new Map<string, GitChangeKind>();
  for (const { path, kind } of changes) {
    kinds.set(path, selectStrongerKind(kinds.get(path), kind));
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
