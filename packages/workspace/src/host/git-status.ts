import { Effect } from 'effect';
import type { GitChange, GitChangeKind } from '@moonbase/contracts/workspace';
import { GitStatusFormatError } from '@moonbase/contracts/workspace-host-errors';

// The record stays on the host: it can name a checkout's paths.
const unrecognized = () => new GitStatusFormatError();

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

/** A side's kind: null when it is unchanged (a space), undefined for a letter Git does not use. */
function readKind(code: string): GitChangeKind | null | undefined {
  if (code === ' ') return null;
  return Object.hasOwn(kindsByCode, code) ? kindsByCode[code] : undefined;
}

/**
 * The changes in `git status --porcelain=v1 -z` output: a staged and an unstaged entry for each
 * side that differs, one `untracked` entry for a new file and one `conflicted` entry for an
 * unmerged path, `missing` when both sides deleted it. Ignored records are skipped, and a rename
 * or copy lists only its target.
 */
export const parseGitStatus = (output: string): Effect.Effect<GitChange[], GitStatusFormatError> =>
  Effect.suspend(() => {
    const records = output.split('\0'),
      changes: GitChange[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== ' ') return Effect.fail(unrecognized());
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
        const staged = readKind(code[0]),
          unstaged = readKind(code[1]);
        if (staged === undefined || unstaged === undefined) return Effect.fail(unrecognized());
        if (staged) changes.push({ path, area: 'staged', kind: staged });
        if (unstaged) changes.push({ path, area: 'unstaged', kind: unstaged });
      }
    }
    return Effect.succeed(changes);
  });
