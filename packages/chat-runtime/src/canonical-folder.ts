import { Effect, FileSystem } from 'effect';

/**
 * Whether a folder exists and is named by its real path, so no link redirects it. `unreadable`
 * means its real path matched but it could not be read after: it may have just been removed, or
 * the read failed, so whether it is canonical is unknown.
 */
export type FolderCheck = 'canonical' | 'not-canonical' | 'missing' | 'unreadable';

/** Checks that `path` is an existing directory named by its real path. */
export const checkCanonicalFolder = (
  path: string,
): Effect.Effect<FolderCheck, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* Effect.option(fs.realPath(path));
    if (real._tag === 'None') return 'missing';
    if (real.value !== path) return 'not-canonical';
    const info = yield* Effect.option(fs.stat(path));
    if (info._tag === 'None') return 'unreadable';
    return info.value.type === 'Directory' ? 'canonical' : 'not-canonical';
  });
