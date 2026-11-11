import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Effect, Layer, Semaphore } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatSession } from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { ConnectionService, type ConnectionServiceShape } from '@moonbase/contracts/services';
import { LoopbackConnectionLive, loopbackProfileId } from '@moonbase/pi-runtime/loopback';
import type { DaemonCommand } from './daemon-command.ts';

/** A local daemon's data directory inside a Moonbase user-data directory (one per profile). */
export const findDaemonDirectory = (userData: string) => join(userData, 'daemon-v1');

export type LocalDaemonOptions = {
  /** The daemon's absolute data directory, `<userData>/daemon-v1`. */
  directory: string;
  /** What starts it: `findDaemonCommand`'s result, spawned exactly as given. */
  command: DaemonCommand;
  /** How long a started daemon may take to listen; 20 seconds. */
  startMs?: number;
  /** How long an outdated daemon may take to stop; 30 seconds. */
  stopMs?: number;
};

const unavailable = (message: string) => new ApplicationError({ code: 'Unavailable', message });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a process with this ID exists (one of another user's still counts). */
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A private file of the daemon's, read without following a link or blocking on a FIFO; undefined
 * when it is missing or isn't a small regular file of this user's with mode 0600.
 */
async function readDaemonFile(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 4096)
      return undefined;
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

type Endpoint = { pid: number; version: unknown; protocol: unknown };
async function readEndpoint(directory: string): Promise<Endpoint | undefined> {
  const value = await readDaemonFile(join(directory, 'endpoint.json'));
  if (!value || typeof value !== 'object') return undefined;
  const { pid, version, protocol } = value as Record<string, unknown>;
  return Number.isSafeInteger(pid) && (pid as number) > 0
    ? { pid: pid as number, version, protocol }
    : undefined;
}

/** The daemon's session: its host and store, and the actor its chats are made by. */
export async function readDaemonSession(directory: string): Promise<ChatSession> {
  try {
    return decodeChatInput('listChats', {
      session: await readDaemonFile(join(directory, 'identity.json')),
    }).session;
  } catch {
    throw unavailable('The local chat daemon’s identity is unreadable.');
  }
}

/**
 * Whether `pid` runs a daemon on `directory`: its command line ends with the directory, the
 * daemon's only argument. A crashed daemon's endpoint can name an ID another process has reused.
 */
async function runsDaemon(pid: number, directory: string) {
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'args='], {
      timeout: 5000,
    });
    return stdout.trimEnd().endsWith(` ${directory}`);
  } catch {
    return false;
  }
}

export type LocalDaemon = ReturnType<typeof createLocalDaemon>;
/**
 * Finds or starts the local daemon on one data directory. A daemon outlives the app: it is
 * started detached with no stdio (it logs to its own files) and is never stopped here, except an
 * outdated one, which is replaced. Finding and starting run one at a time.
 */
export function createLocalDaemon({
  directory,
  command,
  startMs = 20_000,
  stopMs = 30_000,
}: LocalDaemonOptions) {
  let pid: number | undefined, child: ChildProcess | undefined, busy: Promise<void> | undefined;
  const serialize = (run: () => Promise<void>) => {
    const next = (busy ?? Promise.resolve()).then(run, run);
    busy = next.catch(() => {});
    return next;
  };

  /** Stops a daemon from another app version, which this app can't talk to, and waits for it. */
  async function stopOutdated(outdated: number) {
    if (!(await runsDaemon(outdated, directory))) return;
    // A daemon stops cleanly on SIGTERM; Pi Durable resumes its interrupted runs in the next one.
    try {
      process.kill(outdated, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + stopMs;
    while (isAlive(outdated)) {
      if (Date.now() > deadline)
        throw unavailable('An older Moonbase chat daemon is still stopping. Try again shortly.');
      await delay(50);
    }
  }

  /** Starts a daemon and waits until its endpoint names it, which it writes once listening. */
  async function start() {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw unavailable('The local chat data folder is unavailable.');
    });
    const started = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: 'ignore',
    });
    started.unref();
    let exited = false;
    started.once('exit', () => (exited = true));
    const failed = new Promise<never>((_, reject) => {
      started.once('error', () =>
        reject(unavailable('Moonbase could not start its local chat daemon.')),
      );
    });
    failed.catch(() => {});
    const deadline = Date.now() + startMs;
    try {
      for (;;) {
        await Promise.race([delay(25), failed]);
        const endpoint = await readEndpoint(directory);
        if (endpoint && endpoint.pid === started.pid) break;
        // Another daemon may hold the directory's lock; then that one is the daemon to use.
        if (exited) throw unavailable('The local chat daemon stopped while starting.');
        if (Date.now() > deadline) {
          started.kill('SIGTERM');
          throw unavailable('The local chat daemon did not start in time.');
        }
      }
    } catch (error) {
      if (exited) {
        const endpoint = await readEndpoint(directory);
        if (endpoint && isAlive(endpoint.pid) && endpoint.version === chatHostVersion) {
          pid = endpoint.pid;
          child = undefined;
          return;
        }
      }
      throw error;
    }
    pid = started.pid;
    child = started;
  }

  return {
    directory,
    /** Whether the daemon last found or started is still running. */
    isRunning: () =>
      pid !== undefined &&
      (child ? child.exitCode === null && child.signalCode === null : isAlive(pid)),
    /**
     * Makes sure a current daemon runs: the one `endpoint.json` names if it is alive and this
     * app's version, else a new one, after stopping an outdated one.
     */
    ensure: () =>
      serialize(async () => {
        const endpoint = await readEndpoint(directory);
        if (endpoint && isAlive(endpoint.pid)) {
          if (endpoint.version === chatHostVersion && endpoint.protocol === chatProtocolVersion) {
            if (endpoint.pid !== pid) child = undefined;
            pid = endpoint.pid;
            return;
          }
          await stopOutdated(endpoint.pid);
        }
        await start();
      }),
    /** Starts a new daemon even though one seems to run, for a daemon that stopped answering. */
    restart: () => serialize(start),
  };
}

/**
 * The loopback connection to the local daemon, which it restarts on demand: before each endpoint
 * lookup, a daemon that exited (crashed, or stopped once idle) is found or started again and
 * reconnected, so the next request reaches a running daemon in a new connection generation. Chat
 * watches of the old generation fail as `Unavailable` and their clients reconnect them.
 */
export const LocalDaemonConnectionLive = (
  daemon: LocalDaemon,
): Layer.Layer<ConnectionService, ApplicationError> =>
  Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      const inner = yield* ConnectionService;
      const lock = yield* Semaphore.make(1);
      const connected = Effect.map(
        inner.getConnection({}),
        (state) => state.state === 'connected' && daemon.isRunning(),
      );
      const connect = inner.connect({ profileId: loopbackProfileId });
      const promise = (run: () => Promise<void>) =>
        Effect.tryPromise({
          try: run,
          catch: (error) =>
            ApplicationError.is(error)
              ? error
              : unavailable('Moonbase could not start its local chat daemon.'),
        });
      const recover = lock.withPermits(1)(
        Effect.gen(function* () {
          // Another lookup may have recovered while this one waited.
          if (yield* connected) return;
          yield* promise(daemon.ensure);
          const first = yield* Effect.result(connect);
          if (first._tag === 'Success') return;
          if (first.failure.code !== 'Unavailable') return yield* Effect.fail(first.failure);
          // Its process runs but nothing answers: start a daemon that will.
          yield* promise(daemon.restart);
          yield* connect;
        }),
      );
      return {
        ...inner,
        endpoint: (input) =>
          Effect.flatMap(connected, (ready) =>
            Effect.flatMap(ready ? Effect.void : recover, () => inner.endpoint(input)),
          ),
      } satisfies ConnectionServiceShape;
    }),
  ).pipe(Layer.provide(LoopbackConnectionLive({ directory: daemon.directory })));
