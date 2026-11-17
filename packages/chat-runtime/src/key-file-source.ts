import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import type { CredentialKeyError } from '@moonbase/contracts/provider-errors';
import {
  decodeKey,
  keyError,
  makeEncodedKey,
  type CredentialKeySource,
} from './credential-key-source.ts';
import { getErrorCode, isPrivateFile, readWholeFile } from './private-file.ts';

/**
 * A key in an explicit file: base64 of 32 bytes and an optional newline, so
 * `openssl rand -base64 32 > key && chmod 600 key` makes one. The file must be a regular file owned
 * by the user with mode 0600 or stricter, not a symlink, in a directory nobody else can write to.
 */
export const makeKeyFileSource = (
  path: string,
): Effect.Effect<CredentialKeySource, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const notPrivate = () => keyError('file-not-private');
    const notKey = () => keyError('file-not-key');
    // The uid checks need another owner, which only root can arrange, so tests cover modes and
    // symlinks; a root-owned folder such as a system directory is accepted.
    const checkFolder = Effect.gen(function* () {
      const info = yield* Effect.option(fs.stat(dirname(path)));
      if (Option.isNone(info) || info.value.type !== 'Directory')
        return yield* Effect.fail(keyError('file-folder-missing'));
      const owner = Option.getOrElse(info.value.uid, () => -1);
      if ((owner !== process.getuid?.() && owner !== 0) || info.value.mode & 0o022)
        return yield* Effect.fail(notPrivate());
    });
    const load: Effect.Effect<Uint8Array | undefined, CredentialKeyError> = Effect.scoped(
      Effect.gen(function* () {
        if (!isAbsolute(path)) return yield* Effect.fail(notPrivate());
        yield* checkFolder;
        const opened = yield* fs.open(path, { flag: 'r', noFollow: true }).pipe(
          Effect.map(Option.some),
          Effect.catchTag('PlatformError', (error) => {
            if (error.reason._tag === 'NotFound') return Effect.succeed(Option.none());
            return Effect.fail(
              getErrorCode(error) === 'ELOOP' ? notPrivate() : keyError('file-unreadable'),
            );
          }),
        );
        if (Option.isNone(opened)) return undefined;
        const file = opened.value;
        const info = yield* Effect.mapError(file.stat, () => keyError('file-unreadable'));
        if (info.type !== 'File' || !isPrivateFile(info)) return yield* Effect.fail(notPrivate());
        if (Number(info.size) > 128) return yield* Effect.fail(notKey());
        const text = yield* Effect.mapError(readWholeFile(file), () => keyError('file-unreadable'));
        const key = decodeKey(text.toString('utf8').replace(/\n$/, ''));
        if (!key) return yield* Effect.fail(notKey());
        return key;
      }),
    );
    // Writes a new key beside the path and links it in; link never replaces an existing file, so a
    // key made concurrently wins and is read back. The temporary file goes whatever happens.
    const write = Effect.gen(function* () {
      const temporary = join(dirname(path), '.' + randomUUID());
      const store = Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(temporary, { flag: 'wx', mode: 0o600 });
            yield* file.writeAll(Buffer.from(makeEncodedKey() + '\n'));
            yield* file.sync;
          }),
        );
        yield* fs
          .link(temporary, path)
          .pipe(Effect.catchReason('PlatformError', 'AlreadyExists', () => Effect.void));
      });
      yield* store.pipe(
        Effect.mapError(() => keyError('file-not-created')),
        Effect.ensuring(Effect.ignore(fs.remove(temporary))),
      );
    });
    return {
      available: Effect.succeed(true),
      load,
      create: Effect.gen(function* () {
        const existing = yield* load;
        if (existing) return existing;
        yield* write;
        const stored = yield* load;
        if (!stored) return yield* Effect.fail(keyError('file-not-created'));
        return stored;
      }),
    } satisfies CredentialKeySource;
  });
