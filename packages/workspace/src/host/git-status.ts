import type { GitChange, GitChangeKind } from '@moonbase/contracts/workspace';
import { WorkspaceUnavailableError } from '@moonbase/contracts/workspace-host-errors';

const unrecognized = (record: string) =>
  new WorkspaceUnavailableError({
    reason: `Unrecognized Git status record: ${JSON.stringify(record)}`,
  });

/** XY pairs Git prints for an unmerged path. */
const unmergedCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
/** A status letter's kind. A rename or copy target is a path that did not exist before. */
const kindsByCode: Readonly<Record<string, GitChangeKind>> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  T: 'typechange',
  R: 'added',
  C: 'added',
};

function readKind(code: string, record: string) {
  if (!Object.hasOwn(kindsByCode, code)) throw unrecognized(record);
  return kindsByCode[code];
}

/**
 * The changes in `git status --porcelain=v1 -z` output: a staged and an unstaged entry for each
 * side that differs, one `untracked` entry for a new file and one `conflicted` entry for an
 * unmerged path, `missing` when both sides deleted it. Ignored records are skipped, and a rename
 * or copy lists only its target.
 */
export function parseGitStatus(output: string): GitChange[] {
  const records = output.split('\0'),
    changes: GitChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw unrecognized(record);
    const code = record.slice(0, 2),
      path = record.slice(3);
    // A rename or copy record is followed by its source path.
    if (/[RC]/.test(code)) index++;
    if (code === '!!') continue;
    if (code === '??') changes.push({ path, area: 'untracked', kind: 'untracked' });
    // Both sides deleted the path, so the working tree has no file at it.
    else if (code === 'DD')
      changes.push({ path, area: 'conflicted', kind: 'conflicted', missing: true });
    else if (unmergedCodes.has(code))
      changes.push({ path, area: 'conflicted', kind: 'conflicted' });
    else {
      if (code[0] !== ' ') changes.push({ path, area: 'staged', kind: readKind(code[0], record) });
      if (code[1] !== ' ')
        changes.push({ path, area: 'unstaged', kind: readKind(code[1], record) });
    }
  }
  return changes;
}
