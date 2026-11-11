import { constants } from 'node:fs';
import { open, realpath, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/errors';
import { daemonErrorReasons } from '@moonbase/contracts/daemon';

type Approval = { path: string; dev: number; ino: number; at: string; recent: boolean };
// Picker folders and chat worktrees are kept to separate limits, so worktree chats never push
// out the folders the picker offers again.
const maxRecentApprovals = 50;
const maxWorktreeApprovals = 200;
const maxApprovals = maxRecentApprovals + maxWorktreeApprovals;
const maxRecent = 8;

/**
 * Working folders the native picker approved for local chat, kept in a private file of the chat
 * host's data directory so they stay approved after a restart. Each use checks the folder is still
 * the same directory; a moved or replaced one needs the picker again. The renderer only ever names
 * a path.
 */
export function createFolderApprovals(file: string) {
  let approvals: Promise<Map<string, Approval>> | undefined;
  let saving: Promise<unknown> = Promise.resolve(),
    last = 0;
  // Strictly increasing, so the order of uses within one millisecond survives sorting.
  const now = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  // Uses after a restart stay later than every saved one, even within the same millisecond.
  const load = () =>
    (approvals ??= readApprovals(file).then((map) => {
      for (const approval of map.values()) last = Math.max(last, Date.parse(approval.at) || 0);
      return map;
    }));
  const save = (map: Map<string, Approval>) => {
    const entries = [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
    const kept = new Set([
      ...entries.filter((approval) => approval.recent).slice(0, maxRecentApprovals),
      ...entries.filter((approval) => !approval.recent).slice(0, maxWorktreeApprovals),
    ]);
    for (const old of entries) if (!kept.has(old)) map.delete(old.path);
    const write = saving.then(() =>
      writeApprovals(
        file,
        entries.filter((approval) => kept.has(approval)),
      ),
    );
    saving = write.catch(() => {});
    return write;
  };
  const identity = async (path: string) => {
    const cwd = await realpath(path),
      info = await stat(cwd);
    return { cwd, info };
  };
  /** Whether `path` is exactly an approved folder that is still the same directory. */
  const has = async (path: string) => {
    const approved = (await load()).get(path);
    if (!approved) return false;
    try {
      const { cwd, info } = await identity(path);
      return (
        cwd === path && info.isDirectory() && info.dev === approved.dev && info.ino === approved.ino
      );
    } catch {
      return false;
    }
  };
  return {
    has,
    /**
     * Approves a folder the native picker or main returned. `recent: false` approves it without
     * offering it again, as for a chat's new worktree.
     */
    async approve(path: string, { recent = true }: { recent?: boolean } = {}) {
      const { cwd, info } = await identity(path);
      if (!info.isDirectory()) throw new ApplicationError(daemonErrorReasons['folder-missing']);
      const map = await load();
      map.set(cwd, {
        path: cwd,
        dev: info.dev,
        ino: info.ino,
        at: now(),
        recent: recent || !!map.get(cwd)?.recent,
      });
      // A folder stays approved for this run even if it could not be saved for the next one.
      await save(map).catch(() => {});
      return cwd;
    },
    /**
     * Marks an approved folder as just used, so it leads the recent folders, or for a worktree is
     * the last to lapse.
     */
    async touch(path: string) {
      const map = await load(),
        approved = map.get(path);
      if (!approved) return;
      map.set(path, { ...approved, at: now() });
      await save(map).catch(() => {});
    },
    /** Recently used approved folders that are still the same directory, newest first. */
    async listRecent() {
      const recent = [...(await load()).values()]
        .filter((approval) => approval.recent)
        .sort((a, b) => b.at.localeCompare(a.at));
      const listed: string[] = [];
      for (const approval of recent) {
        if (listed.length === maxRecent) break;
        if (await has(approval.path)) listed.push(approval.path);
      }
      return listed;
    },
  };
}
export type FolderApprovals = ReturnType<typeof createFolderApprovals>;

/**
 * Refuses any folder but one the runtime made directly under `chatFolders` for a chat without a
 * project, named by its real path.
 */
export async function checkChatFolder(chatFolders: string, path: string) {
  const [parent, folder] = await Promise.all([
    realpath(chatFolders).catch(() => ''),
    realpath(path).catch(() => ''),
  ]);
  const info = folder ? await stat(folder).catch(() => null) : null;
  if (!parent || !folder || folder !== path || dirname(folder) !== parent || !info?.isDirectory())
    throw new ApplicationError(daemonErrorReasons['not-chat-folder']);
}

async function readApprovals(file: string) {
  const map = new Map<string, Approval>();
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return map;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 512 * 1024 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      return map;
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(parsed)) return map;
    for (const item of parsed.slice(0, maxApprovals))
      if (
        item &&
        typeof item.path === 'string' &&
        item.path.startsWith('/') &&
        Number.isInteger(item.dev) &&
        Number.isInteger(item.ino) &&
        typeof item.at === 'string' &&
        typeof item.recent === 'boolean'
      )
        map.set(item.path, {
          path: item.path,
          dev: item.dev,
          ino: item.ino,
          at: item.at,
          recent: item.recent,
        });
  } catch {
    // An unreadable list approves nothing; the picker approves folders again.
  } finally {
    await handle.close();
  }
  return map;
}

async function writeApprovals(file: string, approvals: Approval[]) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(approvals));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
