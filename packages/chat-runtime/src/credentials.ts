import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Cause, Effect, FiberSet, FileSystem, Option, RcMap, Semaphore, type Scope } from 'effect';
import * as Schema from 'effect/Schema';
import type { CreateModelsOptions } from '@earendil-works/pi-ai/models';
import { CredentialKeyError, CredentialStoreError } from '@moonbase/contracts/provider-errors';
import { UnreadableCredentialError, type CredentialEncryption } from './credential-encryption.ts';
import { isPrivateFile, readWholeFile } from './private-file.ts';

export { createMemoryKeySource, type CredentialKeySource } from './credential-key-source.ts';
export {
  makeKeyEncryption,
  UnreadableCredentialError,
  type CredentialEncryption,
  type CredentialEncryptionError,
} from './credential-encryption.ts';
export { makeKeyFileSource } from './key-file-source.ts';
export { makeKeychainKeySource, type KeychainKeySourceOptions } from './keychain-key-source.ts';

type CredentialStore = NonNullable<CreateModelsOptions['credentials']>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore['read']>>>;
const failure = () => new CredentialStoreError({ problem: 'failed' });
const credentialSchema = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('api_key'),
      key: Schema.String.check(Schema.makeFilter((value) => !!value.trim())),
    }),
    // OAuth providers own extension metadata such as clientId and scopes.
    Schema.StructWithRest(
      Schema.Struct({
        type: Schema.Literal('oauth'),
        access: Schema.NonEmptyString,
        refresh: Schema.NonEmptyString,
        expires: Schema.Finite,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ]),
);
const decodeCredential = (value: unknown) =>
  Schema.decodeUnknownEffect(credentialSchema, {
    onExcessProperty: 'error',
    reportInput: false,
  })(value).pipe(
    Effect.map((credential) => (credential ?? undefined) as Credential | undefined),
    Effect.mapError(failure),
  );
/**
 * Hides a storage failure: a key source that can't work says why, such as a locked keychain, and
 * an unreadable credential stays distinct; anything else, the platform's or the encryption's own
 * diagnostics included, is `failed`. Interruption passes through.
 */
const protectStorage = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, CredentialKeyError | CredentialStoreError | UnreadableCredentialError, R> =>
  Effect.catchCause(
    effect,
    (
      cause,
    ): Effect.Effect<
      never,
      CredentialKeyError | CredentialStoreError | UnreadableCredentialError
    > => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
      const error = Cause.findErrorOption(cause);
      if (
        Option.isSome(error) &&
        (error.value instanceof CredentialKeyError ||
          error.value instanceof UnreadableCredentialError)
      )
        return Effect.fail(error.value);
      return Effect.fail(failure());
    },
  );
const credentialIds = ['openai', 'openai-api-key', 'anthropic', 'google', 'openrouter'];

/**
 * One private Moonbase namespace, as Pi's Promise-shaped credential store; the process root must
 * hold its single-instance lock. Pi's calls run in the store's Scope, which ends them when it closes.
 */
export const makeCredentialStore = (
  directory: string,
  encryption: CredentialEncryption,
): Effect.Effect<CredentialStore, CredentialStoreError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    if (!isAbsolute(directory)) return yield* Effect.fail(failure());
    const fs = yield* FileSystem.FileSystem;
    const run = yield* FiberSet.makeRuntimePromise();
    // One change at a time per provider, as Pi's `modify` requires.
    const locks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
    const getCredentialPath = (providerId: string) =>
      /^[a-z0-9-]{1,64}$/.test(providerId)
        ? Effect.succeed(join(directory, providerId + '.encrypted'))
        : Effect.fail(failure());
    const prepare = Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const info = yield* fs.lstat(directory);
      if (info.type !== 'Directory' || !isPrivateFile(info)) return yield* Effect.fail(failure());
    });
    // A file is unreadable when the key encryption authenticates it as not sealed under the loaded
    // key (or no key exists), or when it decrypts to something that isn't a credential. Any other
    // failure, such as a locked keychain, a private-file check or I/O, keeps the file.
    const readStored = (providerId: string) =>
      protectStorage(
        Effect.scoped(
          Effect.gen(function* () {
            yield* prepare;
            const path = yield* getCredentialPath(providerId);
            const opened = yield* fs.open(path, { flag: 'r', noFollow: true }).pipe(
              Effect.map(Option.some),
              Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none())),
            );
            if (Option.isNone(opened)) return undefined;
            const file = opened.value;
            const info = yield* file.stat;
            if (info.type !== 'File' || !isPrivateFile(info) || Number(info.size) > 128 * 1024)
              return yield* Effect.fail(failure());
            if (!(yield* encryption.available)) return yield* Effect.fail(failure());
            const plain = yield* encryption.decrypt(yield* readWholeFile(file), providerId);
            return yield* Effect.try(() => JSON.parse(plain) as unknown).pipe(
              Effect.flatMap(decodeCredential),
              Effect.mapError(() => new UnreadableCredentialError()),
            );
          }),
        ),
      );
    const read = (providerId: string) =>
      readStored(providerId).pipe(
        Effect.catchTag('UnreadableCredentialError', () =>
          Effect.fail(new CredentialStoreError({ problem: 'unreadable' })),
        ),
      );
    /** The current credential for a change, where an unreadable file counts as none. */
    const readReplaceable = (providerId: string) =>
      readStored(providerId).pipe(
        Effect.catchTag('UnreadableCredentialError', () => Effect.succeed(undefined)),
      );
    const write = (providerId: string, value: Credential) =>
      protectStorage(
        Effect.gen(function* () {
          const path = yield* getCredentialPath(providerId);
          const plain = JSON.stringify(yield* decodeCredential(value));
          if (Buffer.byteLength(plain) > 64 * 1024) return yield* Effect.fail(failure());
          if (!(yield* encryption.available)) return yield* Effect.fail(failure());
          const encrypted = yield* encryption.encrypt(plain, providerId);
          if (encrypted.byteLength > 128 * 1024) return yield* Effect.fail(failure());
          const temporary = join(directory, '.' + randomUUID());
          const store = Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fs.open(temporary, { flag: 'wx', mode: 0o600 });
                yield* file.writeAll(encrypted);
                yield* file.sync;
              }),
            );
            yield* fs.rename(temporary, path);
          });
          // The temporary file goes whatever happens; failing to remove it fails the write.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const stored = yield* Effect.exit(restore(store));
              yield* fs
                .remove(temporary)
                .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.void));
              return yield* stored;
            }),
          );
        }),
      );
    /** Pi's `signal` is checked where the change starts and again before it writes. */
    const checkSignal = (signal: AbortSignal | undefined) =>
      Effect.suspend(() => (signal?.aborted ? Effect.fail(signal.reason as unknown) : Effect.void));
    const locked = <A>(
      providerId: string,
      work: Effect.Effect<A, unknown>,
      signal: AbortSignal | undefined,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* getCredentialPath(providerId);
          const lock = yield* RcMap.get(locks, providerId);
          return yield* lock.withPermit(Effect.andThen(checkSignal(signal), work));
        }),
      );
    return {
      read: (id, options) => run(locked(id, read(id), options?.signal)),
      list: (options) =>
        run(
          Effect.forEach(
            credentialIds,
            (providerId) =>
              Effect.map(locked(providerId, read(providerId), options?.signal), (value) =>
                value ? [{ providerId, type: value.type }] : [],
              ),
            { concurrency: 'unbounded' },
          ).pipe(Effect.map((values) => values.flat())),
        ),
      modify: (id, change, options) =>
        run(
          locked(
            id,
            Effect.gen(function* () {
              const current = yield* readReplaceable(id);
              // Pi's own rejection, such as a failed refresh, reaches it unchanged.
              const next = yield* Effect.tryPromise({
                try: () => change(current),
                catch: (e) => e,
              });
              if (next !== undefined) {
                yield* checkSignal(options?.signal);
                yield* write(id, next);
              }
              return next ?? current;
            }),
            options?.signal,
          ),
        ),
      delete: (id, options) =>
        run(
          locked(
            id,
            Effect.gen(function* () {
              yield* readReplaceable(id);
              yield* checkSignal(options?.signal);
              const path = yield* getCredentialPath(id);
              yield* protectStorage(
                fs
                  .remove(path)
                  .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.void)),
              );
            }),
            options?.signal,
          ),
        ),
    } satisfies CredentialStore;
  });
