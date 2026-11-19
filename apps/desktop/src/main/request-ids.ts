import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, Ref, Semaphore } from 'effect';
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
     * Forgets `requestId` for `key`, once its outcome is known. An ID issued since, for a later
     * attempt, stays.
     */
    readonly forget: (key: string, requestId: string) => Effect.Effect<void, RequestStoreError>;
  }
>()('moonbase/desktop/RequestIds') {}

/** The file's contents: each key's ID, as the workspace RPC accepts request IDs. */
const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, WorkspaceIdentifierSchema)),
);

/**
 * Request IDs in a small profile-local file holding only unresolved requests. It is read once,
 * the first time it is needed, and rewritten whole and atomically (a synced 0600 file renamed into
 * place, then the folder synced) before the cache changes. A write runs to its end once started,
 * even if its caller is interrupted. After a write fails, the file may or may not hold it, so the
 * folder is synced and the file read again before another ID is returned. A missing file is a
 * fresh profile; an unreadable or corrupt one fails every request, since a new ID could send again
 * what already ran. One change at a time.
 */
export const makeFileRequestIds = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);
    /** The kept IDs, or none until the file has been read (again). */
    const cache = yield* Ref.make(Option.none<ReadonlyMap<string, string>>());
    /** Whether a failed write left the file out of step with the cache, or not yet durable. */
    const unsettled = yield* Ref.make(false);
    const unwritable = () => new RequestStoreError({ failure: 'unwritable' });

    const syncFolder = Effect.scoped(
      Effect.flatMap(fs.open(dirname(file), { flag: 'r' }), (folder) => folder.sync),
    );
    const read = fs.readFileString(file).pipe(
      Effect.catchTag('PlatformError', (error) =>
        error.reason._tag === 'NotFound'
          ? Effect.succeed('{}')
          : Effect.fail(new RequestStoreError({ failure: 'unreadable' })),
      ),
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
        ? syncFolder.pipe(Effect.mapError(unwritable), Effect.andThen(Ref.set(unsettled, false)))
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
          Effect.andThen(fs.rename(temporary, file)),
          Effect.onError(() => Effect.ignore(fs.remove(temporary))),
        );
        yield* syncFolder;
        yield* Ref.set(cache, Option.some(ids));
      }).pipe(
        Effect.tapError(() =>
          Effect.andThen(Ref.set(cache, Option.none()), Ref.set(unsettled, true)),
        ),
        Effect.mapError(unwritable),
        Effect.uninterruptible,
      );

    return RequestIds.of({
      issue: (key) =>
        lock.withPermit(
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
        lock.withPermit(
          Effect.gen(function* () {
            const ids = yield* load;
            if (ids.get(key) !== requestId) return;
            const rest = new Map(ids);
            rest.delete(key);
            yield* write(rest);
          }),
        ),
    });
  });

/** `RequestIds` kept in `file`. */
export const RequestIdsLive = (file: string) => Layer.effect(RequestIds, makeFileRequestIds(file));
