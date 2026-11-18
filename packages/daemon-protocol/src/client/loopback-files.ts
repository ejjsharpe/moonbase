import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { ConnectionError } from '@moonbase/contracts/connection-errors';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { chatProtocolVersion, hostTokenPattern } from '@moonbase/contracts/host';
import { readObject } from '@moonbase/contracts/common';
import { isPrivateTo } from '@moonbase/contracts/files';

// What reading the daemon's files fails with: a `ConnectionError`, since they are how the loopback
// connection reaches it.
const failure = (reason: ConnectionError['reason']) => new ConnectionError({ reason });
const notRunning = () => failure('daemon-not-running');
const unsafe = () => failure('daemon-files-unsafe');
const malformed = () => failure('daemon-files-malformed');
const unreadable = () => failure('daemon-files-unreadable');
const thrown = (error: unknown) => (error instanceof ConnectionError ? error : unreadable());

/**
 * Reads an existing private file without following a link, checking what was opened. Node's
 * `fs` is used rather than the Effect `FileSystem`, which can't open with `O_NOFOLLOW`.
 */
const readPrivateFile = (path: string, maxBytes: number) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: (error) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? notRunning() : unsafe(),
    }),
    (file: FileHandle) =>
      Effect.tryPromise({
        try: async () => {
          const info = await file.stat();
          if (!info.isFile() || !isPrivateTo(info, process.getuid?.())) throw unsafe();
          if (info.size > maxBytes) throw malformed();
          return new TextDecoder('utf8', { fatal: true }).decode(await file.readFile());
        },
        catch: (error) => (error instanceof ConnectionError ? error : malformed()),
      }),
    (file) => Effect.ignore(Effect.tryPromise(() => file.close())),
  );

const parse = <A>(text: string, decode: (value: unknown) => A) =>
  Effect.try({ try: () => decode(JSON.parse(text)), catch: malformed });

/** Refuses a data directory that is missing, a link, or not private to this user. */
const checkDirectory = (directory: string) =>
  Effect.tryPromise({ try: () => lstat(directory), catch: notRunning }).pipe(
    Effect.flatMap((info) =>
      !info.isDirectory() || info.isSymbolicLink() || !isPrivateTo(info, process.getuid?.())
        ? Effect.fail(unsafe())
        : Effect.void,
    ),
  );

const parseIdentity = (identity: string) =>
  parse(identity, (value) => decodeChatInput('listChats', { session: value }).session.host);

/** The daemon's host and store, from its directory's `identity.json`. */
export const readDaemonIdentity = (directory: string) =>
  checkDirectory(directory).pipe(
    Effect.andThen(readPrivateFile(join(directory, 'identity.json'), 4096)),
    Effect.flatMap(parseIdentity),
    Effect.mapError(thrown),
  );

/** The daemon's identity, its listening port, process and token, read fresh from its directory. */
export const readDaemonFiles = (directory: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(directory);
    const [identity, endpoint, token] = yield* Effect.all(
      [
        readPrivateFile(join(directory, 'identity.json'), 4096),
        readPrivateFile(join(directory, 'endpoint.json'), 4096),
        readPrivateFile(join(directory, 'token'), 8192),
      ],
      { concurrency: 'unbounded' },
    );
    const host = yield* parseIdentity(identity);
    const { port, pid, protocol } = yield* parse(endpoint, (value) => {
      const record = readObject(value, ['port', 'pid', 'version', 'protocol', 'build']);
      if (
        !Number.isSafeInteger(record.port) ||
        (record.port as number) < 1 ||
        (record.port as number) > 65535 ||
        !Number.isSafeInteger(record.pid) ||
        (record.pid as number) < 1 ||
        !Number.isSafeInteger(record.protocol)
      )
        throw Error();
      return {
        port: record.port as number,
        pid: record.pid as number,
        protocol: record.protocol as number,
      };
    });
    if (protocol !== chatProtocolVersion) return yield* Effect.fail(failure('daemon-protocol'));
    const key = token.trim();
    if (!hostTokenPattern.test(key)) return yield* Effect.fail(malformed());
    return { expected: host, origin: `http://127.0.0.1:${port}`, port, pid, token: key };
  }).pipe(Effect.mapError(thrown));
