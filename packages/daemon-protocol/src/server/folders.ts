import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  daemonErrorReasons,
  type FolderApprovals,
  maximumHostFolders,
} from '@moonbase/contracts/daemon';
import { isPrivateTo } from '@moonbase/contracts/files';

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
export function createFolderApprovals(file: string): FolderApprovals {
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
    refusal: 'folder-not-approved',
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

/**
 * A local-mode daemon's folders plus its workspace's: chats may also use a folder that `checkouts`
 * says is the root of an approved checkout. Only `has` widens. Picker
 * approvals, the recent list and `approve` are the picker's alone, so a project the editor opened
 * is never offered again as a recent folder. A `checkouts` that throws approves nothing.
 */
export function withCheckoutFolders(
  folders: FolderApprovals,
  checkouts: { has(path: string): Promise<boolean> },
): FolderApprovals {
  return {
    ...folders,
    async has(path) {
      if (await folders.has(path)) return true;
      return checkouts.has(path).catch(() => false);
    },
  };
}

/** Exact, for real paths in their on-disk spelling; fold first to compare as macOS volumes do. */
const isInside = (root: string, path: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
const folded = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * A host-mode daemon's folders: its approved roots and any folder under one, named by its real
 * path. Each root is checked at startup and must stay the same directory, so a root replaced by
 * another folder or a link approves nothing, and a path through a link never resolves to itself.
 * Nothing is stored: a remote client has no picker for the host's disk, so it chooses from the
 * roots and their subfolders. A root that holds or sits in a `reserved` path is refused.
 */
export async function createRootFolders(
  roots: readonly string[],
  { reserved = [] }: { reserved?: readonly string[] } = {},
): Promise<FolderApprovals> {
  const identities = await Promise.all(
    roots.map(async (root) => {
      const info = await lstat(root).catch(() => null);
      if (!info?.isDirectory() || (await realpath(root).catch(() => '')) !== root)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Each approved root must be an existing folder named by its real path.',
        });
      return { root, dev: info.dev, ino: info.ino };
    }),
  );
  // A root holding the daemon's data or credential key would let chats and `@` search read them.
  // Folded, as a path not made yet keeps the case it was named in.
  const held = (await Promise.all(reserved.map(findRealPath))).map(folded);
  if (
    identities.some(({ root }) =>
      held.some((path) => isInside(folded(root), path) || isInside(path, folded(root))),
    )
  )
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'An approved root must not hold the daemon’s data or credential key.',
    });
  /** Whether a root is still the directory it was at startup. */
  const unchanged = async ({ root, dev, ino }: (typeof identities)[number]) => {
    const info = await lstat(root).catch(() => null);
    return !!info?.isDirectory() && info.dev === dev && info.ino === ino;
  };
  const has = async (path: string) => {
    const real = await realpath(path).catch(() => '');
    if (!real || real !== path || !(await stat(real).catch(() => null))?.isDirectory())
      return false;
    const root = identities.find((identity) => isInside(identity.root, real));
    return !!root && (await unchanged(root));
  };
  return {
    has,
    refusal: 'folder-outside-roots',
    async approve(path) {
      const real = await realpath(path).catch(() => {
        throw new ApplicationError(daemonErrorReasons['folder-missing']);
      });
      if (!(await has(real)))
        throw new ApplicationError(daemonErrorReasons['folder-outside-roots']);
      return real;
    },
    async touch() {},
    async listRecent() {
      return [];
    },
    /** The roots, then the folders directly inside each, sorted; hidden folders and links are left out. */
    async listFolders() {
      const listed: string[] = [],
        children: string[] = [];
      for (const identity of identities) {
        if (!(await unchanged(identity))) continue;
        listed.push(identity.root);
        // A root that can't be read lists only itself.
        const entries = await readdir(identity.root, {
          withFileTypes: true,
        }).catch(() => []);
        children.push(
          ...entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => join(identity.root, name)),
        );
      }
      return [...listed, ...children].slice(0, maximumHostFolders);
    },
  };
}

/** A path's real path, through its folder when the path itself doesn't exist yet. */
async function findRealPath(path: string) {
  return realpath(path).catch(async () =>
    join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path)),
  );
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
    if (!info.isFile() || info.size > 512 * 1024 || !isPrivateTo(info, process.getuid?.()))
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
