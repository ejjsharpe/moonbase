import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import type { ChatSession } from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { decodeDaemonSettings, type DaemonSettings } from './daemon-settings.ts';
import { DataDirectoryError } from './daemon-errors.ts';
import { readOrCreatePrivateFile, readPrivateFile, replacePrivateFile } from './private-files.ts';

/** Decodes a data file's JSON; anything it can't decode is malformed, and named by nothing. */
const parse = <A>(bytes: Uint8Array, decode: (value: unknown) => A) =>
  Effect.try({
    try: () => decode(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))),
    catch: () => new DataDirectoryError({ problem: 'malformed' }),
  });

/** `identity.json`: random host, store and actor IDs, created once. */
export const readIdentity = (directory: string) =>
  Effect.flatMap(
    readOrCreatePrivateFile(join(directory, 'identity.json'), 4096, () =>
      JSON.stringify({
        host: { hostId: randomUUID(), storeId: randomUUID() },
        actorId: randomUUID(),
      }),
    ),
    (bytes) =>
      parse(
        bytes,
        (value): ChatSession => decodeChatInput('listChats', { session: value }).session,
      ),
  );

/** `token`: 32 random bytes, base64url; the whole authority of a client. */
export const readToken = (directory: string) =>
  Effect.flatMap(
    readOrCreatePrivateFile(join(directory, 'token'), 4096, () =>
      randomBytes(32).toString('base64url'),
    ),
    (bytes) => {
      const token = new TextDecoder().decode(bytes).trim();
      // At least 32 bytes of entropy as base64url, and within the host protocol's token bound.
      return /^[A-Za-z0-9_-]{43,4096}$/.test(token)
        ? Effect.succeed(token)
        : Effect.fail(new DataDirectoryError({ problem: 'malformed' }));
    },
  );

/** `daemon.json`: optional settings, strictly decoded; a local-mode daemon when absent. */
export const readSettings = (directory: string) =>
  Effect.flatMap(
    readPrivateFile(join(directory, 'daemon.json'), 64 * 1024),
    (bytes): Effect.Effect<DaemonSettings, DataDirectoryError> =>
      Option.isNone(bytes)
        ? Effect.succeed({ mode: 'local' })
        : // Settings it can't decode make the file malformed, as any other data file.
          parse(bytes.value, decodeDaemonSettings),
  );

/** `build` identifies the daemon's code: its bundle's digest, or `development` from source. */
export type Endpoint = {
  port: number;
  pid: number;
  version: string;
  protocol: number;
  build: string;
};

/** `endpoint.json`, written atomically once the daemon listens. */
export const writeEndpoint = (directory: string, endpoint: Endpoint) =>
  replacePrivateFile(join(directory, 'endpoint.json'), JSON.stringify(endpoint));

export const removeEndpoint = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.ignore(fs.remove(join(directory, 'endpoint.json')));
  });
