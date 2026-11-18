import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option } from 'effect';
import * as Schema from 'effect/Schema';
import { ChatSessionSchema } from '@moonbase/contracts/chat-schema';
import { isPrivateTo } from '@moonbase/contracts/files';
import { LocalDaemonError } from './local-daemon-errors.ts';

/** A local daemon's data directory inside a Moonbase user-data directory (one per profile). */
export const findDaemonDirectory = (userData: string) => join(userData, 'daemon-v1');

/**
 * What main reads of `endpoint.json`: the process, and the protocol and build it speaks. A daemon
 * of another version may write more, or no build.
 */
const EndpointSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  protocol: Schema.Number,
  build: Schema.optional(Schema.String),
});
export type DaemonEndpoint = typeof EndpointSchema.Type;
const decodeEndpoint = Schema.decodeUnknownOption(Schema.fromJsonString(EndpointSchema));
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(ChatSessionSchema), {
  onExcessProperty: 'error',
});

/**
 * A private file of the daemon's: none when it is missing or isn't a small regular file of this
 * user's with mode 0600. It is opened without following a link or blocking on a FIFO, which
 * Effect's `FileSystem` has no flag for, so this open is `node:fs`, wrapped once here.
 */
const readDaemonFile = (path: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    ),
    (file) =>
      Effect.tryPromise(async () => {
        const info = await file.stat();
        if (!info.isFile() || !isPrivateTo(info, process.getuid?.()) || info.size > 4096)
          return Option.none<string>();
        return Option.some(await file.readFile('utf8'));
      }),
    (file) => Effect.promise(() => file.close().catch(() => {})),
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()));

/** The daemon `endpoint.json` names, which writes it once it listens; none if it is unreadable. */
export const readDaemonEndpoint = (directory: string) =>
  Effect.map(readDaemonFile(join(directory, 'endpoint.json')), Option.flatMap(decodeEndpoint));

/** The daemon's session from `identity.json`: its host and store, and the actor its chats are made by. */
export const readDaemonSession = (directory: string) =>
  readDaemonFile(join(directory, 'identity.json')).pipe(
    Effect.map(Option.flatMap(decodeSession)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new LocalDaemonError({ reason: 'identity-unreadable' })),
        onSome: Effect.succeed,
      }),
    ),
  );
