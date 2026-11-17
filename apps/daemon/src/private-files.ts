import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import { isPrivateTo } from '@moonbase/contracts/files';
import { DataDirectoryError } from './daemon-errors.ts';

// The private files of the daemon's data directory. A file is opened without following a link and
// checked once open; Effect's `FileSystem` has no flag for that, so those opens are `node:fs`,
// wrapped here. Everything else goes through `FileSystem`.

const unsafe = () => new DataDirectoryError({ problem: 'unsafe' });
const malformed = () => new DataDirectoryError({ problem: 'malformed' });

/** Whether a file's owner and mode make it private to this process's user. */
export const isPrivate = (info: { uid: number | Option.Option<number>; mode: number }) =>
  isPrivateTo(
    {
      uid: typeof info.uid === 'number' ? info.uid : Option.getOrElse(info.uid, () => -1),
      mode: info.mode,
    },
    process.getuid?.(),
  );

/**
 * Opens `path` with `flags` and `O_NOFOLLOW`, so a link fails (ELOOP, or EMLINK on some systems),
 * and closes it with the scope. Fails with the error `open` threw.
 */
export const openNoFollow = (path: string, flags: number, mode?: number) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(path, flags | constants.O_NOFOLLOW, mode),
      catch: (error) => error as NodeJS.ErrnoException,
    }),
    (file) => Effect.promise(() => file.close().catch(() => {})),
  );

/** Creates or validates one private directory: 0700, owned by this user, not a symlink. */
export const openPrivateDirectory = (path: string) =>
  Effect.gen(function* () {
    if (!isAbsolute(path)) return yield* new DataDirectoryError({ problem: 'relative' });
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(path, { mode: 0o700 })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === 'AlreadyExists'
            ? Effect.void
            : Effect.fail(new DataDirectoryError({ problem: 'uncreatable' })),
        ),
      );
    const info = yield* Effect.mapError(fs.lstat(path), unsafe);
    if (info.type !== 'Directory' || !isPrivate(info)) return yield* unsafe();
    return path;
  });

/**
 * Creates `path` as an empty 0600 file unless it exists, and checks it is a private regular file,
 * for files another library opens later and would otherwise create with the default mode.
 */
export const preparePrivateFile = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.mapError(
        openNoFollow(path, constants.O_RDWR | constants.O_CREAT, 0o600),
        unsafe,
      );
      const info = yield* Effect.tryPromise({ try: () => file.stat(), catch: unsafe });
      if (!info.isFile() || !isPrivate(info)) return yield* unsafe();
    }),
  );

/** Reads an existing private file, opened without following a link; none when it is absent. */
export const readPrivateFile = (path: string, maxBytes: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* openNoFollow(path, constants.O_RDONLY).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.code === 'ENOENT' ? Effect.succeedNone : Effect.fail(unsafe()),
        ),
      );
      if (Option.isNone(opened)) return Option.none<Uint8Array>();
      const file = opened.value;
      const info = yield* Effect.tryPromise({ try: () => file.stat(), catch: unsafe });
      if (!info.isFile() || !isPrivate(info)) return yield* unsafe();
      if (info.size > maxBytes) return yield* malformed();
      const bytes = yield* Effect.tryPromise({ try: () => file.readFile(), catch: unsafe });
      return Option.some<Uint8Array>(bytes);
    }),
  );

/** Writes `contents` to a new 0600 file beside `path`, synced, and returns its path. */
const writeBeside = (path: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = `${path}.${process.pid}.new`;
    yield* Effect.ignore(fs.remove(temporary));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, { flag: 'wx', mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(contents));
        yield* file.sync;
      }),
    );
    return temporary;
  });

/** Makes the link or rename that put `path` in place durable, by syncing its folder. */
const syncDirectory = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.open(dirname(path), { flag: 'r' });
    yield* folder.sync;
  }).pipe(Effect.scoped);

/**
 * Writes a new 0600 file beside `path` and links it into place, so a crash never leaves a partial
 * file and an existing one is never replaced. Succeeds with false when `path` already exists.
 */
export const createPrivateFile = (path: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* writeBeside(path, contents);
    return yield* fs.link(temporary, path).pipe(
      Effect.andThen(syncDirectory(path)),
      Effect.as(true),
      Effect.catch((error) =>
        error.reason._tag === 'AlreadyExists' ? Effect.succeed(false) : Effect.fail(error),
      ),
      Effect.ensuring(Effect.ignore(fs.remove(temporary))),
    );
  });

/** Replaces `path` atomically with a new 0600 file. */
export const replacePrivateFile = (path: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* writeBeside(path, contents);
    yield* fs.rename(temporary, path);
    yield* syncDirectory(path);
  });

/** Reads a private file, creating it once with `create()` when it does not exist. */
export const readOrCreatePrivateFile = (path: string, maxBytes: number, create: () => string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = yield* readPrivateFile(path, maxBytes);
      if (Option.isSome(existing)) return existing.value;
      yield* Effect.mapError(
        createPrivateFile(path, create()),
        () => new DataDirectoryError({ problem: 'file-uncreatable' }),
      );
    }
    return yield* malformed();
  });
