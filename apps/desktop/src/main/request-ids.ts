import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, Ref, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { RequestStoreError } from '@moonbase/contracts/ipc-errors';

/**
 * Request IDs of host operations whose outcome is unknown, kept across reloads and restarts until
 * the caller learns the outcome and forgets them.
 */
export class RequestIds extends Context.Service<
  RequestIds,
  {
    /** The ID kept for `key`, or a new one, kept durably before it is returned. */
    readonly issue: (key: string) => Effect.Effect<string, RequestStoreError>;
    /** Forgets the ID kept for `key`, once its outcome is known. */
    readonly forget: (key: string) => Effect.Effect<void, RequestStoreError>;
  }
>()('moonbase/desktop/RequestIds') {}

const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
 * Request IDs in a small profile-local file holding only unresolved requests. It is read once,
 * the first time it is needed, and rewritten whole and atomically (a synced 0600 file renamed into
 * place) before the cache changes. A missing file is a fresh profile; an unreadable or corrupt one
 * fails every request, since a new ID could send again what already ran. One change at a time.
 */
export const makeFileRequestIds = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);
    const cache = yield* Ref.make(Option.none<ReadonlyMap<string, string>>());

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
    /** The kept IDs, read from the file only until a read succeeds. */
    const load = Effect.flatMap(
      Ref.get(cache),
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.tap(read, (ids) => Ref.set(cache, Option.some(ids))),
      }),
    );
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
        yield* Effect.scoped(Effect.flatMap(fs.open(dirname(file), { flag: 'r' }), (d) => d.sync));
        yield* Ref.set(cache, Option.some(ids));
      }).pipe(Effect.mapError(() => new RequestStoreError({ failure: 'unwritable' })));

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
      forget: (key) =>
        lock.withPermit(
          Effect.gen(function* () {
            const ids = yield* load;
            if (!ids.has(key)) return;
            const rest = new Map(ids);
            rest.delete(key);
            yield* write(rest);
          }),
        ),
    });
  });

/** `RequestIds` kept in `file`. */
export const RequestIdsLive = (file: string) => Layer.effect(RequestIds, makeFileRequestIds(file));
