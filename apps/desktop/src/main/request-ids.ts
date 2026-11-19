import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Ref,
  Semaphore,
} from 'effect';
import * as Schema from 'effect/Schema';
import { RequestStoreError } from '@moonbase/contracts/ipc-errors';
import { WorkspaceIdentifierSchema } from '@moonbase/contracts/workspace-schema';

/**
 * Request IDs of host operations whose outcome is unknown, kept across reloads and restarts until
 * the caller learns the outcome and forgets them.
 */
export class RequestIds extends Context.Service<
  RequestIds,
  {
    /** The ID kept for `key`, or a new one, kept durably before it is returned. */
    readonly issue: (key: string) => Effect.Effect<string, RequestStoreError>;
    /**
     * Forgets `requestId` for `key`, once its outcome is known, in the background: the caller
     * never waits for the write, and a failure is logged and leaves the ID, which only asks the
     * host again for the outcome it already gave. An ID issued since, for a later attempt, stays.
     */
    readonly forget: (key: string, requestId: string) => Effect.Effect<void>;
  }
>()('moonbase/desktop/RequestIds') {}

/** The file's contents: each key's ID, as the workspace RPC accepts request IDs. */
const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, WorkspaceIdentifierSchema)),
);
/** Decodes UTF-8 strictly, so a damaged byte is corruption rather than a different key. */
const decodeText = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () => new RequestStoreError({ failure: 'corrupt' }),
  });

/**
 * Request IDs in a small profile-local file holding only unresolved requests. It is read once,
 * the first time it is needed, and rewritten whole and atomically (a synced 0600 file renamed into
 * place, then the folder synced) before the cache changes. One change at a time.
 *
 * The store runs its changes in its own fibers, so a caller that goes away (an interrupted
 * request, a released document) never waits for a write, and a write once started runs to its end
 * rather than close a file under it. Closing the store waits for that one write. A write that fails
 * before its rename leaves the file as it was; one that fails at or after it, however it fails,
 * may or may not have replaced it, so the folder is synced and the file read again before another
 * ID is returned. The same holds for a write an earlier run left unsynced, so the first read after
 * opening syncs the folder too, and a store whose folder won't sync fails every request. A missing
 * file (or folder) is a fresh profile; an unreadable or corrupt one fails every request, since a
 * new ID could send again what already ran.
 */
export const makeFileRequestIds = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);
    const changes = yield* FiberSet.make();
    /** The kept IDs, or none until the file has been read (again). */
    const cache = yield* Ref.make(Option.none<ReadonlyMap<string, string>>());
    /**
     * Whether the file may have been replaced without being made durable: by a failed write, or,
     * until the folder first syncs, by an earlier run.
     */
    const unsettled = yield* Ref.make(true);
    const unwritable = () => new RequestStoreError({ failure: 'unwritable' });

    const syncFolder = Effect.scoped(
      Effect.flatMap(fs.open(dirname(file), { flag: 'r' }), (folder) => folder.sync),
    );
    const read = fs.readFile(file).pipe(
      Effect.catchTag('PlatformError', (error) =>
        error.reason._tag === 'NotFound'
          ? Effect.succeed(new TextEncoder().encode('{}'))
          : Effect.fail(new RequestStoreError({ failure: 'unreadable' })),
      ),
      Effect.flatMap(decodeText),
      Effect.flatMap((text) =>
        decodeIds(text).pipe(
          Effect.map((ids) => new Map(Object.entries(ids))),
          Effect.mapError(() => new RequestStoreError({ failure: 'corrupt' })),
        ),
      ),
    );
    /** Makes durable what a failed write may have left in the file, so it can be read again. */
    const settle = Effect.flatMap(Ref.get(unsettled), (pending) =>
      pending
        ? syncFolder.pipe(
            // A folder not made yet holds no file: a fresh profile.
            Effect.catchTag('PlatformError', (error) =>
              error.reason._tag === 'NotFound' ? Effect.void : Effect.fail(unwritable()),
            ),
            Effect.andThen(Ref.set(unsettled, false)),
          )
        : Effect.void,
    );
    /** The kept IDs, read from the file only until a read succeeds, and again after a failed write. */
    const load = Effect.flatMap(
      Ref.get(cache),
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          settle.pipe(
            Effect.andThen(read),
            Effect.tap((ids) => Ref.set(cache, Option.some(ids))),
          ),
      }),
    );
    /** Writes `ids` in place of the file. It runs uninterruptibly, so no write is left pending. */
    const write = (ids: ReadonlyMap<string, string>) =>
      Effect.gen(function* () {
        /** Set once the rename may have replaced the file. */
        const renaming = yield* Ref.make(false);
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(file), { recursive: true });
          const temporary = `${file}.${randomUUID()}.tmp`;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(temporary, { flag: 'wx', mode: 0o600 });
              yield* handle.writeAll(
                new TextEncoder().encode(JSON.stringify(Object.fromEntries(ids))),
              );
              yield* handle.sync;
            }),
          ).pipe(
            Effect.andThen(Ref.set(renaming, true)),
            Effect.andThen(fs.rename(temporary, file)),
            Effect.onError(() => Effect.ignore(fs.remove(temporary))),
          );
          yield* syncFolder;
          yield* Ref.set(cache, Option.some(ids));
        }).pipe(
          // A failure of any kind once the rename began leaves the file unknown.
          Effect.onExit((exit) =>
            Effect.flatMap(Ref.get(renaming), (renamed) =>
              Exit.isFailure(exit) && renamed
                ? Effect.andThen(Ref.set(cache, Option.none()), Ref.set(unsettled, true))
                : Effect.void,
            ),
          ),
        );
      }).pipe(Effect.mapError(unwritable), Effect.uninterruptible);
    /** Runs `change` in the store's own fiber, which outlives its caller. */
    const runChange = <A>(change: Effect.Effect<A, RequestStoreError>) =>
      Effect.flatMap(FiberSet.run(changes, lock.withPermit(change)), Fiber.join);

    return RequestIds.of({
      issue: (key) =>
        runChange(
          Effect.gen(function* () {
            const ids = yield* load;
            const kept = ids.get(key);
            if (kept !== undefined) return kept;
            const requestId = randomUUID();
            yield* write(new Map(ids).set(key, requestId));
            return requestId;
          }),
        ),
      forget: (key, requestId) =>
        Effect.asVoid(
          FiberSet.run(
            changes,
            lock
              .withPermit(
                Effect.gen(function* () {
                  const ids = yield* load;
                  if (ids.get(key) !== requestId) return;
                  const rest = new Map(ids);
                  rest.delete(key);
                  yield* write(rest);
                }),
              )
              .pipe(Effect.ignoreCause({ log: 'Warn' })),
          ),
        ),
    });
  });

/** `RequestIds` kept in `file`, for as long as the layer's scope. */
export const RequestIdsLive = (file: string) => Layer.effect(RequestIds, makeFileRequestIds(file));
