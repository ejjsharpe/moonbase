import { isAbsolute } from 'node:path';
import { Data, Effect, FileSystem, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { CredentialKeyError } from '@moonbase/contracts/provider-errors';
import {
  decodeKey,
  keyError,
  makeEncodedKey,
  type CredentialKeySource,
} from './credential-key-source.ts';

export type KeychainKeySourceOptions = {
  /** The store this key belongs to; the item's account. */
  storeId: string;
  /** An explicit keychain file; otherwise the user's default keychain and search list. */
  keychain?: string;
  /** How long one `security` command may run, including any unlock prompt. */
  timeoutMs?: number;
  /** Replaces the check for macOS and `/usr/bin/security`, for tests that fake it on any OS. */
  available?: Effect.Effect<boolean>;
};
const keychainService = 'Moonbase daemon credentials';
/** `security -i` reads lines of under 4096 bytes, and no answer of ours is longer. */
const lineBytes = 4096;
// `security -i` splits lines on whitespace and quotes, so only values without quotes of either
// kind, backslashes or control characters reach a command.
const isQuotable = (value: string) =>
  [...value].every((character) => !'"\'\\\x7f'.includes(character) && character >= ' ');
/** `security` could not start, ran out of time or printed more than any answer of ours. */
class SecurityStopped extends Data.TaggedError('SecurityStopped') {}

/**
 * A generic-password item (service `Moonbase daemon credentials`, account `storeId`) read and
 * written by `/usr/bin/security -i`, with every command on its stdin so the key never reaches argv.
 */
export const makeKeychainKeySource = (
  options: KeychainKeySourceOptions,
): Effect.Effect<
  CredentialKeySource,
  CredentialKeyError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const { storeId, keychain, timeoutMs = 120_000 } = options;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(storeId)) return yield* Effect.fail(keyError('store-id'));
    if (keychain !== undefined && (!isAbsolute(keychain) || !isQuotable(keychain)))
      return yield* Effect.fail(keyError('keychain-path'));
    const suffix = keychain === undefined ? '' : ` "${keychain}"`;
    const item = `-s "${keychainService}" -a "${storeId}"`;
    // The add command, with a key, is the longest line.
    if (
      Buffer.byteLength(`add-generic-password ${item} -w "${'A'.repeat(44)}"${suffix}`) >= lineBytes
    )
      return yield* Effect.fail(keyError('keychain-path-length'));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    /** Whether this is macOS with `/usr/bin/security`, which this source runs. */
    const available =
      options.available ??
      (process.platform !== 'darwin'
        ? Effect.succeed(false)
        : fs.stat('/usr/bin/security').pipe(
            Effect.map((info) => info.type === 'File'),
            Effect.orElseSucceed(() => false),
          ));
    const failed = (status: number | null) =>
      status === 36
        ? keyError('keychain-locked')
        : new CredentialKeyError({
            problem: 'keychain-failed',
            ...(status === null ? {} : { status }),
          });
    /** Runs one command line; a spawn failure, a timeout or too much output is a stopped command. */
    const run = (line: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (Buffer.byteLength(line) >= lineBytes)
            return yield* Effect.fail(new SecurityStopped());
          const handle = yield* spawner.spawn(
            ChildProcess.make('/usr/bin/security', ['-i'], {
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
                ...(process.env.USER === undefined ? {} : { USER: process.env.USER }),
              },
              detached: false,
              // Closing the scope (a timeout or too much output) kills it.
              killSignal: 'SIGKILL',
              stdin: Stream.make(Buffer.from(line + '\n')),
            }),
          );
          const [output, , status] = yield* Effect.all(
            [
              handle.stdout.pipe(
                Stream.decodeText,
                Stream.runFoldEffect(
                  () => '',
                  (output, chunk) =>
                    output.length + chunk.length > lineBytes
                      ? Effect.fail(new SecurityStopped())
                      : Effect.succeed(output + chunk),
                ),
              ),
              // Diagnostics may name the keychain; they are drained and never surfaced.
              Stream.runDrain(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: 'unbounded' },
          );
          return { status: status as number, output };
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new SecurityStopped()),
        }),
        Effect.mapError(() => failed(null)),
      );
    const requireAvailable = Effect.flatMap(available, (ok) =>
      ok ? Effect.void : Effect.fail(keyError('keychain-missing')),
    );
    const load = Effect.gen(function* () {
      yield* requireAvailable;
      const { status, output } = yield* run(`find-generic-password ${item} -w${suffix}`);
      if (status === 44) return undefined;
      if (status !== 0) return yield* Effect.fail(failed(status));
      const key = decodeKey(output.replace(/\n$/, ''));
      if (!key) return yield* Effect.fail(keyError('keychain-not-key'));
      return key;
    });
    return {
      available,
      load,
      create: Effect.gen(function* () {
        const existing = yield* load;
        if (existing) return existing;
        const { status } = yield* run(
          `add-generic-password ${item} -w "${makeEncodedKey()}"${suffix}`,
        );
        // 45 is a duplicate item: another writer created the key first, so read theirs.
        if (status !== 0 && status !== 45) return yield* Effect.fail(failed(status));
        const stored = yield* load;
        if (!stored) return yield* Effect.fail(failed(status));
        return stored;
      }),
    } satisfies CredentialKeySource;
  });
