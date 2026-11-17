import { Clock, Effect, FileSystem, Option, Schema, Semaphore } from 'effect';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import { FolderMissingError } from '@moonbase/contracts/folder-errors';
import { readPrivateFile, replacePrivateFile } from './private-files.ts';

const ApprovalSchema = Schema.Struct({
  path: Schema.String.check(Schema.makeFilter((path) => path.startsWith('/'))),
  dev: Schema.Int,
  ino: Schema.Int,
  at: Schema.String,
  recent: Schema.Boolean,
});
type Approval = typeof ApprovalSchema.Type;
const decodeApproval = Schema.decodeUnknownOption(ApprovalSchema);
// Picker folders and chat worktrees are kept to separate limits, so worktree chats never push
// out the folders the picker offers again.
const maxRecentApprovals = 50;
const maxWorktreeApprovals = 200;
const maxApprovals = maxRecentApprovals + maxWorktreeApprovals;
const maxRecent = 8;
const maxFileBytes = 512 * 1024;

/**
 * The saved approvals: a private file, opened without following a link. One that is missing,
 * unsafe or unreadable approves nothing (the picker approves folders again), as does any entry in
 * it that is not a whole approval.
 */
const readApprovals = (file: string) =>
  readPrivateFile(file, maxFileBytes).pipe(
    Effect.map((bytes) => {
      const map = new Map<string, Approval>();
      if (Option.isNone(bytes)) return map;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.value));
      if (!Array.isArray(parsed)) return map;
      for (const item of parsed.slice(0, maxApprovals)) {
        const approval = decodeApproval(item);
        if (Option.isSome(approval)) map.set(approval.value.path, approval.value);
      }
      return map;
    }),
    Effect.orElseSucceed(() => new Map<string, Approval>()),
    Effect.catchDefect(() => Effect.succeed(new Map<string, Approval>())),
  );

/**
 * Working folders the native picker approved for local chat, kept in a private file of the chat
 * host's data directory so they stay approved after a restart. Each use checks the folder is still
 * the same directory; a moved or replaced one needs the picker again. The renderer only ever names
 * a path. The file is read once, at the first use; saves run one at a time, each writing the
 * approvals as they are when it runs, so the last save holds every approval made before it.
 */
export const makeFolderApprovals = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const saves = yield* Semaphore.make(1);
    // Strictly increasing, so the order of uses within one millisecond survives sorting.
    let last = 0;
    const now = Effect.map(Clock.currentTimeMillis, (millis) =>
      new Date((last = Math.max(millis, last + 1))).toISOString(),
    );
    // Uses after a restart stay later than every saved one, even within the same millisecond.
    const load = yield* Effect.cached(
      Effect.tap(readApprovals(file), (map) =>
        Effect.sync(() => {
          for (const approval of map.values()) last = Math.max(last, Date.parse(approval.at) || 0);
        }),
      ),
    );
    /** Saves the approvals, keeping each kind to its limit; the newest win. */
    const save = (map: Map<string, Approval>) =>
      saves.withPermit(
        Effect.suspend(() => {
          const entries = [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
          const kept = new Set([
            ...entries.filter((approval) => approval.recent).slice(0, maxRecentApprovals),
            ...entries.filter((approval) => !approval.recent).slice(0, maxWorktreeApprovals),
          ]);
          for (const old of entries) if (!kept.has(old)) map.delete(old.path);
          return replacePrivateFile(
            file,
            JSON.stringify(entries.filter((approval) => kept.has(approval))),
          ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        }),
      );
    /** A folder's real path and what is there now. */
    const identity = (path: string) =>
      Effect.gen(function* () {
        const cwd = yield* fs.realPath(path);
        return { cwd, info: yield* fs.stat(cwd) };
      });
    /** Whether `path` is exactly an approved folder that is still the same directory. */
    const has = (path: string) =>
      Effect.gen(function* () {
        const approved = (yield* load).get(path);
        if (!approved) return false;
        const { cwd, info } = yield* identity(path);
        return (
          cwd === path &&
          info.type === 'Directory' &&
          Number(info.dev) === approved.dev &&
          Option.map(info.ino, Number).pipe(Option.getOrUndefined) === approved.ino
        );
      }).pipe(Effect.orElseSucceed(() => false));
    return {
      has,
      refusal: 'not-approved',
      /**
       * Approves a folder the native picker or main returned. `recent: false` approves it without
       * offering it again, as for a chat's new worktree. A folder stays approved for this run
       * even if it could not be saved for the next one.
       */
      approve: (path, { recent = true } = {}) =>
        Effect.gen(function* () {
          const { cwd, info } = yield* Effect.mapError(
            identity(path),
            () => new FolderMissingError(),
          );
          if (info.type !== 'Directory') return yield* new FolderMissingError();
          const map = yield* load;
          map.set(cwd, {
            path: cwd,
            dev: Number(info.dev),
            ino: Option.getOrElse(Option.map(info.ino, Number), () => 0),
            at: yield* now,
            recent: recent || !!map.get(cwd)?.recent,
          });
          yield* Effect.ignore(save(map));
          return cwd;
        }),
      /**
       * Marks an approved folder as just used, so it leads the recent folders, or for a worktree is
       * the last to lapse.
       */
      touch: (path) =>
        Effect.gen(function* () {
          const map = yield* load,
            approved = map.get(path);
          if (!approved) return;
          map.set(path, { ...approved, at: yield* now });
          yield* Effect.ignore(save(map));
        }),
      /** Recently used approved folders that are still the same directory, newest first. */
      listRecent: () =>
        Effect.gen(function* () {
          const recent = [...(yield* load).values()]
            .filter((approval) => approval.recent)
            .sort((a, b) => b.at.localeCompare(a.at));
          const listed: string[] = [];
          for (const approval of recent) {
            if (listed.length === maxRecent) break;
            if (yield* has(approval.path)) listed.push(approval.path);
          }
          return listed;
        }),
    } satisfies FolderApprovals;
  });
