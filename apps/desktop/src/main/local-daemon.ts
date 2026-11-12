import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context, Effect, Layer, Semaphore } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatSession } from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import {
  ConnectionService,
  LocalHostService,
  type ConnectionServiceShape,
} from '@moonbase/contracts/services';
import { LoopbackConnectionLive, loopbackProfileId } from '@moonbase/daemon-protocol/loopback';
import { RemoteLocalHostLive } from '@moonbase/daemon-protocol/remote';
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
  /** How often an outdated daemon is asked whether it still has work; 30 seconds. */
  replaceMs?: number;
};

/** Why local chat is Unavailable while an older app's daemon, of another protocol, still runs. */
export const olderDaemonMessage =
  'An older Moonbase daemon is still finishing its work. Local chat starts once it stops.';
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

type Endpoint = { pid: number; protocol: unknown; build: unknown };
async function readEndpoint(directory: string): Promise<Endpoint | undefined> {
  const value = await readDaemonFile(join(directory, 'endpoint.json'));
  if (!value || typeof value !== 'object') return undefined;
  const { pid, protocol, build } = value as Record<string, unknown>;
  return Number.isSafeInteger(pid) && (pid as number) > 0
    ? { pid: pid as number, protocol, build }
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
 * The daemon entries a running daemon may have been started on, besides this app's own: another
 * version's packaged bundle, or the source entry in development.
 */
const daemonEntries = ['/Contents/Resources/daemon/daemon.mjs', '/apps/daemon/src/main.ts'];

/**
 * Whether `pid` runs a daemon on `directory`: its command line ends with a daemon entry followed
 * by the directory, the daemon's only argument. A crashed daemon's endpoint can name an ID another
 * process has reused.
 */
async function runsDaemon(pid: number, directory: string, entry: string | undefined) {
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'args='], {
      timeout: 5000,
    });
    const args = stdout.trimEnd();
    if (!args.endsWith(` ${directory}`)) return false;
    const head = args.slice(0, -directory.length - 1);
    return [...(entry ? [entry] : []), ...daemonEntries].some((known) => head.endsWith(known));
  } catch {
    return false;
  }
}

export type LocalDaemon = ReturnType<typeof createLocalDaemon>;
/**
 * Finds or starts the local daemon on one data directory. A daemon outlives the app: it is
 * started detached with no stdio (it logs to its own files) and is never stopped here, except an
 * outdated one, which is replaced once it has no work. Finding, starting and replacing run one at
 * a time.
 *
 * A daemon of another build that speaks this protocol is used while it runs and marked outdated;
 * `replace` stops it (`SIGTERM`) and starts this app's. One that speaks another protocol is never
 * signalled: local chat is Unavailable until it exits by itself, idle with no client connected.
 */
export function createLocalDaemon({
  directory,
  command,
  startMs = 20_000,
  stopMs = 30_000,
  replaceMs = 30_000,
}: LocalDaemonOptions) {
  // The entry this app starts, the argument before the directory.
  const entry = command.args.at(-2);
  const isDaemon = (candidate: number) => runsDaemon(candidate, directory, entry);
  let pid: number | undefined,
    child: ChildProcess | undefined,
    outdated = false,
    stopped = false,
    busy: Promise<void> | undefined;
  const serialize = (run: () => Promise<void>) => {
    const next = (busy ?? Promise.resolve()).then(run, run);
    busy = next.catch(() => {});
    return next;
  };
  /** Uses the running daemon `endpoint` names, which speaks this protocol. */
  const adopt = (endpoint: Endpoint) => {
    if (endpoint.pid !== pid) child = undefined;
    pid = endpoint.pid;
    outdated = endpoint.build !== command.build;
  };

  /**
   * Stops a daemon of this directory, and waits for it; false, signalling nothing, when
   * that process no longer runs a daemon here (it exited, and its ID was reused).
   */
  async function stopDaemon(outdatedPid: number) {
    if (!(await isDaemon(outdatedPid))) return false;
    // A daemon stops cleanly on SIGTERM; Pi Durable resumes its interrupted runs in the next one.
    try {
      process.kill(outdatedPid, 'SIGTERM');
    } catch {
      return true;
    }
    const deadline = Date.now() + stopMs;
    while (isAlive(outdatedPid)) {
      if (Date.now() > deadline)
        throw unavailable('The Moonbase chat daemon is still stopping. Try again shortly.');
      await delay(50);
    }
    return true;
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
        // Only a running daemon of this directory that speaks this protocol, not a reused ID.
        const endpoint = await readEndpoint(directory);
        if (
          endpoint &&
          endpoint.protocol === chatProtocolVersion &&
          isAlive(endpoint.pid) &&
          (await isDaemon(endpoint.pid))
        )
          return adopt(endpoint);
      }
      throw error;
    }
    pid = started.pid;
    child = started;
    outdated = false;
  }

  /**
   * Makes sure a daemon this app can use runs: the one `endpoint.json` names if it is alive and
   * speaks this protocol (outdated if another build), else a new one.
   */
  async function find() {
    const endpoint = await readEndpoint(directory);
    if (endpoint && isAlive(endpoint.pid)) {
      if (endpoint.protocol === chatProtocolVersion) return adopt(endpoint);
      // An older app's daemon may be running its agents; it exits once idle with nobody connected.
      if (await isDaemon(endpoint.pid)) throw unavailable(olderDaemonMessage);
    }
    await start();
  }

  return {
    directory,
    replaceMs,
    /** Whether the daemon last found or started is still running. */
    isRunning: () =>
      pid !== undefined &&
      (child ? child.exitCode === null && child.signalCode === null : isAlive(pid)),
    /** Whether the daemon in use is of another build, to be replaced once it has no work. */
    isOutdated: () => outdated,
    ensure: () => serialize(find),
    /** Starts a new daemon even though one seems to run, for a daemon that stopped answering. */
    restart: () => serialize(start),
    /**
     * Stops the daemon of this directory (`SIGTERM`, so its runs resume in the next one), whether
     * or not it is outdated or busy, and waits for it. The next request starts a new one. False,
     * signalling nothing, when no process runs a daemon here.
     */
    stop: () =>
      serialize(async () => {
        const running = pid ?? (await readEndpoint(directory))?.pid;
        stopped = running !== undefined && (await stopDaemon(running));
      }).then(() => stopped),
    /** Stops the outdated daemon in use, which reported no work, and starts this app's. */
    replace: () =>
      serialize(async () => {
        if (!outdated || pid === undefined) return;
        // Its endpoint still names a process that isn't the daemon; this app's starts instead.
        if (await stopDaemon(pid)) await find();
        else await start();
      }),
  };
}

/**
 * The loopback connection to the local daemon, which it restarts on demand: before each endpoint
 * lookup, a daemon that exited (crashed, or stopped once idle) is found or started again and
 * reconnected, so the next request reaches a running daemon in a new connection generation. Chat
 * watches of the old generation fail as `Unavailable` and their clients reconnect them.
 *
 * While the daemon in use is outdated, it is asked every `replaceMs` whether it has active work;
 * once it has none, it is replaced by this app's daemon and reconnected the same way.
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
      const promise = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (error) =>
            ApplicationError.is(error)
              ? error
              : unavailable('Moonbase could not start its local chat daemon.'),
        });
      const replace = lock.withPermits(1)(
        Effect.gen(function* () {
          yield* promise(daemon.replace);
          yield* connect;
        }),
      );
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
      const connection = {
        ...inner,
        endpoint: (input) =>
          Effect.flatMap(connected, (ready) =>
            Effect.flatMap(ready ? Effect.void : recover, () => inner.endpoint(input)),
          ),
      } satisfies ConnectionServiceShape;
      // Its own daemon link, since the shared one is built over this connection: it opens a
      // second socket only once an outdated daemon is asked whether it is idle.
      const host = Context.get(
        yield* Layer.build(
          RemoteLocalHostLive.pipe(Layer.provide(Layer.succeed(ConnectionService, connection))),
        ),
        LocalHostService,
      );
      // Asking keeps the outdated daemon from idling out, so it is replaced rather than left.
      const replaceOnceIdle = Effect.gen(function* () {
        if (!daemon.isOutdated() || !daemon.isRunning()) return;
        const session = yield* promise(() => readDaemonSession(daemon.directory));
        const { active } = yield* host.getActiveWork({ host: session.host });
        if (!active && daemon.isOutdated()) yield* replace;
      });
      yield* Effect.sleep(daemon.replaceMs).pipe(
        Effect.andThen(Effect.ignore(replaceOnceIdle)),
        Effect.forever,
        Effect.forkScoped,
      );
      return connection;
    }),
  ).pipe(Layer.provide(LoopbackConnectionLive({ directory: daemon.directory })));

/**
 * The Restart daemon action: after the user confirms, stops the local daemon with `SIGTERM`. Its
 * runs resume in the next daemon, which the next request starts. A failure is reported, never
 * thrown.
 */
export async function restartDaemon({
  daemon,
  confirm,
  report,
}: {
  daemon: Pick<LocalDaemon, 'stop'>;
  confirm(): Promise<boolean>;
  report(message: string): void;
}) {
  if (!(await confirm())) return;
  try {
    if (!(await daemon.stop())) report('No Moonbase daemon was running, so nothing was restarted.');
  } catch (error) {
    report(error instanceof Error ? error.message : 'The daemon could not be restarted.');
  }
}
