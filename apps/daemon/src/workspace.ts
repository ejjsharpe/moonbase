import { join } from 'node:path';
import {
  Cause,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Scope,
} from 'effect';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import {
  WorkspaceFolders,
  WorkspaceHostLive,
  type ChatFolders,
  type RootPredicate,
} from '@moonbase/workspace';
import type { DaemonSettings } from './daemon-settings.ts';
import { describeFailure } from './daemon-errors.ts';
import { journal } from './journal.ts';
import { openPrivateDirectory } from './private-files.ts';

// Folded as APFS compares names: a worktree location's parent need not be spelled as its real path.
const isInside = (outer: string, path: string) => {
  const [a, b] = [outer.normalize('NFC').toLowerCase(), path.normalize('NFC').toLowerCase()];
  return b === a || b.startsWith(a === '/' ? '/' : `${a}/`);
};

/**
 * Where the workspace may not go, and which roots it may open. Paths reserved in both modes are
 * the daemon's secrets and state; local mode also refuses any root inside the data directory except
 * under `chats/`, and host mode opens only what `folders` (the approved roots) allows, by real
 * path: one named through a link is refused, as is a root replaced since startup.
 */
export const createRootPolicy = (
  directory: string,
  settings: DaemonSettings,
  folders: FolderApprovals,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const data = yield* fs.realPath(directory),
      chats = join(data, 'chats');
    // A root holding any of these, or inside one, is refused. That includes holding the data
    // directory, which holds `token`; roots inside the data directory are refused below.
    const reserved = [
      join(data, 'token'),
      join(data, 'credentials'),
      join(data, 'workspace'),
      ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
    ];
    // A host's roots neither hold nor sit inside the data directory (checked at startup), and
    // `folders` has only real paths under them, so nothing it allows is inside the data directory.
    const allowRoot: RootPredicate =
      settings.mode === 'host'
        ? (real, requested) => (real === requested ? folders.has(real) : Effect.succeed(false))
        : (real) => Effect.succeed(!isInside(data, real) || isInside(chats, real));
    return { reserved, allowRoot };
  });

/** The workspace file host while it is open; a daemon without one has none of these. */
export type Workspace = {
  host?: WorkspaceHostServiceShape;
  /** Whether `path` is an approved checkout root, which a local daemon's chats may use. */
  hasFolder(path: string): Effect.Effect<boolean, unknown>;
};
export const noWorkspace: Workspace = { hasFolder: () => Effect.succeed(false) };

/**
 * Closes the workspace's scope, waiting at most `deadline`. A close that fails (a stale lock, say)
 * or never finishes (a helper that never exits) is journalled by code and shutdown goes on.
 */
export const closeWorkspace = (scope: Scope.Closeable, deadline: Duration.Duration) =>
  Effect.gen(function* () {
    // Detached, so the deadline stops the wait and not the close.
    const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
    const closed = yield* Effect.timeoutOption(Fiber.await(closing), deadline);
    if (Option.isNone(closed)) yield* journal({ event: 'workspace', reason: 'close-timeout' });
    else if (Exit.isFailure(closed.value))
      yield* journal({
        event: 'workspace',
        reason: 'close-failed',
        code: describeFailure(Cause.squash(closed.value.cause)).code,
      });
  });

export type WorkspaceOptions = {
  /** Set to the workspace once it is open, and back to none once it starts closing. */
  current: Ref.Ref<Workspace>;
  directory: string;
  settings: DaemonSettings;
  hostId: string;
  folders: FolderApprovals;
  /** A local daemon's chats, for Turn into project; a host's chats never become projects. */
  chats?: ChatFolders;
  filesystemHelper?: string;
  ripgrepExecutable?: string;
  /** How long closing waits for the workspace before going on without it. */
  closeDeadline: Duration.Duration;
};

/**
 * Composes the workspace file host on macOS in a scope of its own, with the data in `workspace/`,
 * this daemon's host ID and the root policy of its mode. A host that can't be composed (no helper,
 * an unqualified runtime, an unusable store) is journalled by code and left out: chats are
 * unaffected. `current` holds the open workspace, and none once closing begins, so chats never
 * ask a closed one. The close it returns (also run when the daemon's scope closes) runs once: it cancels
 * the helper process groups and waits for them, at most `closeDeadline`, so a helper that never
 * exits can't keep the daemon, and with it the directory's lock, from exiting.
 */
export const openWorkspace = (options: WorkspaceOptions) =>
  Effect.gen(function* () {
    const { current } = options;
    const scope = yield* Scope.make();
    const close = yield* Effect.cached(
      Effect.andThen(Ref.set(current, noWorkspace), closeWorkspace(scope, options.closeDeadline)),
    );
    yield* Effect.addFinalizer(() => close);
    if (process.platform !== 'darwin') return close;
    if (!options.filesystemHelper) {
      yield* journal({ event: 'workspace', reason: 'no-helper' });
      return close;
    }
    const { filesystemHelper } = options;
    const opened = yield* Effect.exit(
      Effect.gen(function* () {
        const workspaceDirectory = yield* openPrivateDirectory(
          join(options.directory, 'workspace'),
        );
        const policy = yield* createRootPolicy(
          options.directory,
          options.settings,
          options.folders,
        );
        const services = yield* Layer.build(
          WorkspaceHostLive({
            dataDirectory: workspaceDirectory,
            hostId: options.hostId,
            filesystemHelper,
            gitExecutable: '/usr/bin/git',
            ...(options.ripgrepExecutable ? { ripgrepExecutable: options.ripgrepExecutable } : {}),
            // A native source is held to no root policy, so only a local daemon takes imports.
            nativeImports: options.settings.mode !== 'host',
            ...(options.chats ? { chats: options.chats } : {}),
            ...policy,
          }),
        ).pipe(Scope.provide(scope));
        const checkouts = Context.get(services, WorkspaceFolders);
        return {
          host: Context.get(services, WorkspaceHostService),
          hasFolder: (path: string) => checkouts.has(path),
        } satisfies Workspace;
      }),
    );
    if (Exit.isFailure(opened)) {
      if (Cause.hasInterruptsOnly(opened.cause)) return yield* Effect.failCause(opened.cause);
      yield* Scope.close(scope, Exit.void);
      yield* journal({
        event: 'workspace',
        reason: 'unavailable',
        code: describeFailure(Cause.squash(opened.cause)).code,
      });
      return close;
    }
    yield* Ref.set(current, opened.value);
    yield* journal({ event: 'workspace', reason: 'ready' });
    return close;
  });
