import {
  hostTokenPattern,
  decodeChatHostTarget,
  chatProtocolVersion,
  type ChatHostHealth,
} from '@moonbase/contracts/host';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Effect, Layer, Queue, Semaphore, Stream, type Cause } from 'effect';
import { ApplicationError, fail } from '@moonbase/contracts/errors';
import {
  type ConnectionProfile,
  type ConnectionSnapshot,
  decodeConnectionInput,
} from '@moonbase/contracts/connection';
import { decodeChatInput } from '@moonbase/contracts/chat';
import { ConnectionService, type ConnectionServiceShape } from '@moonbase/contracts/services';
import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import { checkHostHealth } from '@moonbase/ssh/host-health';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { readObject } from '@moonbase/contracts/common';
import { isPrivateTo } from '@moonbase/contracts/files';

export type LoopbackConnectionConfiguration = {
  /** The absolute data directory of a daemon on this machine. */
  directory: string;
  /** The connection's label; "This Mac" by default. */
  label?: string;
};

/** The connection's only profile. */
export const loopbackProfileId = 'loopback';
const maximumObservers = 64;

const failure = (code: ApplicationError['code'], message: string) =>
  new ApplicationError({ code, message });
const unsafe = () =>
  failure(
    'Unavailable',
    'The daemon data directory or one of its files is not private to this user.',
  );
const malformed = () => failure('Unavailable', 'The daemon’s connection files are malformed.');

/** Opens an existing private file without following a link and checks what was opened. */
async function readPrivateFile(path: string, maxBytes: number) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw failure('Unavailable', 'The daemon is not running.');
    throw unsafe();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || !isPrivateTo(info, process.getuid?.())) throw unsafe();
    if (info.size > maxBytes) throw malformed();
    return new TextDecoder('utf8', { fatal: true }).decode(await file.readFile());
  } catch (error) {
    throw ApplicationError.is(error) ? error : malformed();
  } finally {
    await file.close();
  }
}
const parse = <A>(text: string, decode: (value: unknown) => A) => {
  try {
    return decode(JSON.parse(text));
  } catch {
    throw malformed();
  }
};

/** Refuses a data directory that is missing, a link, or not private to this user. */
async function checkDirectory(directory: string) {
  const info = await lstat(directory).catch(() => {
    throw failure('Unavailable', 'The daemon is not running.');
  });
  if (!info.isDirectory() || info.isSymbolicLink() || !isPrivateTo(info, process.getuid?.()))
    throw unsafe();
}
const parseIdentity = (identity: string) =>
  parse(identity, (value) => decodeChatInput('listChats', { session: value }).session).host;

/** The daemon's host and store, from its directory's `identity.json`. */
async function readDaemonIdentity(directory: string) {
  await checkDirectory(directory);
  return parseIdentity(await readPrivateFile(join(directory, 'identity.json'), 4096));
}

/** The daemon's identity, its listening port and its token, read fresh from its directory. */
async function readDaemonFiles(directory: string) {
  await checkDirectory(directory);
  const [identity, endpoint, token] = await Promise.all([
    readPrivateFile(join(directory, 'identity.json'), 4096),
    readPrivateFile(join(directory, 'endpoint.json'), 4096),
    readPrivateFile(join(directory, 'token'), 8192),
  ]);
  const host = parseIdentity(identity);
  const { port, pid, protocol } = parse(endpoint, (value) => {
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
  if (protocol !== chatProtocolVersion)
    throw failure('Incompatible', 'The daemon speaks another protocol version.');
  const key = token.trim();
  if (!hostTokenPattern.test(key)) throw malformed();
  return { expected: host, origin: `http://127.0.0.1:${port}`, port, pid, token: key };
}

/** A verified connection to one daemon process, which its endpoint's `pid` names. */
type Generation = {
  id: string;
  origin: string;
  pid: number;
  token: string;
  health: ChatHostHealth;
};

/**
 * A privileged `ConnectionService` for a daemon on this machine. It is built from the daemon's
 * `identity.json` alone and starts disconnected, so it builds while the daemon is stopped; each
 * connect reads `identity.json`, `endpoint.json` and `token` from its data directory, then verifies signed
 * health for that exact host and store. A connect that finds the same daemon process (port and
 * `pid` in `endpoint.json`) keeps the current generation; one that finds it restarted or replaced,
 * even on the same port, starts a new generation. The token never
 * leaves this service's endpoint lookup, so keep it out of renderers.
 */
export function LoopbackConnectionLive(
  config: LoopbackConnectionConfiguration,
): Layer.Layer<ConnectionService, ApplicationError> {
  return Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      if (typeof config.directory !== 'string' || !isAbsolute(config.directory))
        return yield* Effect.fail(
          failure('InvalidInput', 'Supply the absolute path of the daemon data directory.'),
        );
      const label = config.label ?? 'This Mac';
      // oxlint-disable-next-line no-control-regex -- Labels reject control characters.
      if (typeof label !== 'string' || !/^[^\x00-\x1f\x7f]{1,128}$/.test(label))
        return yield* Effect.fail(failure('InvalidInput', 'Choose a short connection label.'));
      const readFiles = <A>(read: (directory: string) => Promise<A>) =>
        Effect.tryPromise({
          try: () => read(config.directory),
          catch: (error) =>
            ApplicationError.is(error)
              ? error
              : failure('Unavailable', 'The daemon’s connection files could not be read.'),
        });
      const read = () => readFiles(readDaemonFiles);
      // The expected identity is the directory's at startup; a different one later is refused.
      const expected = yield* readFiles(readDaemonIdentity);
      let profile: ConnectionProfile = {
        id: loopbackProfileId,
        label,
        destination: '127.0.0.1',
        expected,
      };
      let state: ConnectionSnapshot = { profile, state: 'disconnected', connectionId: null },
        current: Generation | undefined,
        closed = false;
      const observers = new Set<Queue.Queue<ConnectionSnapshot, Cause.Done>>();
      const lock = yield* Semaphore.make(1);
      const publish = (next: ConnectionSnapshot) => {
        state = next;
        for (const queue of observers) Queue.offerUnsafe(queue, structuredClone(state));
      };
      const isOpen = Effect.suspend(() =>
        closed
          ? Effect.fail(failure('Unavailable', 'Loopback connection scope is closed.'))
          : Effect.void,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          current = undefined;
          for (const queue of observers) Queue.endUnsafe(queue);
          observers.clear();
        }),
      );
      const verify = (origin: string, token: string) =>
        checkHostHealth({ origin, token, expected });
      const connect = Effect.gen(function* () {
        yield* isOpen;
        const files = yield* read().pipe(
          Effect.tap((files) =>
            isSameChatHost(files.expected, expected)
              ? Effect.void
              : Effect.fail(
                  failure('Incompatible', 'The daemon’s host or store identity changed.'),
                ),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              current = undefined;
              publish({ profile, state: 'failed', connectionId: null, message: error.message });
            }),
          ),
        );
        const reuse = current;
        // The token outlives a restart and the port can repeat, so the process tells daemons apart.
        if (
          reuse &&
          reuse.origin === files.origin &&
          reuse.pid === files.pid &&
          reuse.token === files.token
        ) {
          const healthy = yield* Effect.result(verify(reuse.origin, reuse.token));
          if (healthy._tag === 'Success' && current === reuse && state.state === 'connected')
            return structuredClone(state);
        }
        const id = randomUUID();
        current = undefined;
        profile = { ...profile, remotePort: files.port };
        publish({ profile, state: 'connecting', connectionId: id });
        const health = yield* verify(files.origin, files.token).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (!closed)
                publish({ profile, state: 'failed', connectionId: id, message: error.message });
            }),
          ),
        );
        yield* isOpen;
        current = { id, origin: files.origin, pid: files.pid, token: files.token, health };
        publish({ profile, state: 'connected', connectionId: id, health });
        return structuredClone(state);
      });
      const service: ConnectionServiceShape = {
        getConnection: (input) =>
          Effect.flatMap(
            Effect.try({
              try: () => decodeConnectionInput('getConnection', input),
              catch: normalizeApplicationError,
            }),
            () => Effect.as(isOpen, structuredClone(state)),
          ),
        connect: (input) =>
          Effect.flatMap(
            Effect.try({
              try: () => {
                if (decodeConnectionInput('connect', input).profileId !== loopbackProfileId)
                  fail('InvalidInput', 'Choose the loopback connection profile.');
              },
              catch: normalizeApplicationError,
            }),
            () => lock.withPermits(1)(connect),
          ),
        disconnect: (input) =>
          Effect.flatMap(
            Effect.try({
              try: () => decodeConnectionInput('disconnect', input).connectionId,
              catch: normalizeApplicationError,
            }),
            (connectionId) =>
              lock.withPermits(1)(
                Effect.gen(function* () {
                  yield* isOpen;
                  if (state.connectionId === null) return;
                  if (state.connectionId !== connectionId)
                    return yield* Effect.fail(
                      failure('Conflict', 'This disconnect names a stale connection generation.'),
                    );
                  current = undefined;
                  publish({ profile, state: 'disconnected', connectionId: null });
                }),
              ),
          ),
        endpoint: (input) =>
          Effect.try({
            try: () => {
              readObject(input, ['host']);
              const host = decodeChatHostTarget(input.host);
              if (closed) fail('Unavailable', 'Loopback connection scope is closed.');
              if (!isSameChatHost(host, expected))
                fail('Conflict', 'Connection target does not match the daemon’s host and store.');
              if (!current || state.state !== 'connected' || state.connectionId !== current.id)
                fail('Unavailable', 'No verified connection is available for that host and store.');
              return structuredClone({
                origin: current!.origin,
                token: current!.token,
                expected,
                connectionId: current!.id,
                health: current!.health,
              });
            },
            catch: normalizeApplicationError,
          }),
        watch: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.sliding<ConnectionSnapshot, Cause.Done>(1);
              yield* Effect.acquireRelease(
                Effect.gen(function* () {
                  yield* isOpen;
                  if (observers.size >= maximumObservers)
                    return yield* Effect.fail(
                      failure(
                        'Unavailable',
                        'Connection observer limit reached. Close an existing observation before subscribing.',
                      ),
                    );
                  observers.add(queue);
                  Queue.offerUnsafe(queue, structuredClone(state));
                }),
                () =>
                  releaseResource(() => {
                    observers.delete(queue);
                    Queue.endUnsafe(queue);
                  }),
              );
              return Stream.fromQueue(queue);
            }),
          ),
      };
      return service;
    }),
  );
}
