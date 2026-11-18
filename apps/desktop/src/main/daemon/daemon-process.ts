import { Duration, Effect, FileSystem, Option, Ref, Schedule } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import type { DaemonCommand } from './daemon-command.ts';
import { readDaemonEndpoint, type DaemonEndpoint } from './daemon-files.ts';
import { LocalDaemonError } from './local-daemon-errors.ts';

export type DaemonProcessOptions = {
  /** The daemon's absolute data directory, `<userData>/daemon-v1`. */
  directory: string;
  /** What starts it: `findDaemonCommand`'s result, spawned exactly as given. */
  command: DaemonCommand;
  /** How long a started daemon may take to listen; 20 seconds. */
  startMs?: number;
  /** How long a stopped daemon may take to exit; 30 seconds. */
  stopMs?: number;
};

/** How long a start given up on has after SIGTERM before its group gets SIGKILL. */
const startGrace = Duration.seconds(2);
const failure = (reason: LocalDaemonError['reason']) => new LocalDaemonError({ reason });

/** Whether a process with this ID exists (one of another user's still counts). */
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The daemon entries a running daemon may have been started on, besides this app's own: another
 * version's packaged bundle, or the source entry in development.
 */
const daemonEntries = ['/Contents/Resources/daemon/daemon.mjs', '/apps/daemon/src/main.ts'];

/** The daemon in use: its process, this app's handle on it if this app started it, and its build. */
type Running = {
  pid: number;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  outdated: boolean;
};

/**
 * The local daemon's process on one data directory. A daemon outlives the app: it starts detached,
 * in its own process group with no stdio (it logs to its own files), and is released once it
 * listens. Until then it belongs to the start, so a start given up on (its deadline, or Quit)
 * stops the group (SIGTERM, then SIGKILL) and waits for it. A running daemon is stopped only to
 * replace it, or by Restart Daemon.
 *
 * A daemon of another build that speaks this protocol is used while it runs and marked outdated;
 * `replace` stops it (`SIGTERM`) and starts this app's. One that speaks another protocol is left
 * alone: finding fails as `older-daemon` until it exits by itself (idle with no client connected),
 * unless the user stops it with Restart Daemon (`stop`).
 *
 * These are the daemon's process steps only; the local daemon runs them one at a time, under its
 * one lock.
 */
export const makeDaemonProcess = ({
  directory,
  command,
  startMs = 20_000,
  stopMs = 30_000,
}: DaemonProcessOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const state = yield* Ref.make<Running | undefined>(undefined);
    // The entry this app starts, the argument before the directory.
    const entry = command.args.at(-2);
    const readEndpoint = readDaemonEndpoint(directory);

    /**
     * Whether `pid` runs a daemon on this directory: its command line ends with a daemon entry
     * followed by the directory, the daemon's only argument. A crashed daemon's endpoint can name
     * an ID another process has reused.
     */
    const isDaemon = (pid: number) =>
      spawner
        .string(
          ChildProcess.make('/bin/ps', ['-p', String(pid), '-o', 'args='], { detached: false }),
        )
        .pipe(
          Effect.timeout('5 seconds'),
          Effect.map((output) => {
            const args = output.trimEnd();
            if (!args.endsWith(` ${directory}`)) return false;
            const head = args.slice(0, -directory.length - 1);
            return [...(entry ? [entry] : []), ...daemonEntries].some((known) =>
              head.endsWith(known),
            );
          }),
          Effect.orElseSucceed(() => false),
        );

    /** Uses the running daemon `endpoint` names, which speaks this protocol. */
    const adopt = (endpoint: DaemonEndpoint) =>
      Ref.update(state, (current) => ({
        pid: endpoint.pid,
        child: current?.pid === endpoint.pid ? current.child : undefined,
        outdated: endpoint.build !== command.build,
      }));

    /**
     * Stops a daemon of this directory with SIGTERM, and waits for it; false, signalling nothing,
     * when that process no longer runs a daemon here (it exited, and its ID was reused). Only the
     * daemon is signalled: it is usually not this app's child, and one started by hand in
     * development isn't the leader of its process group.
     */
    const stopDaemon = (pid: number) =>
      Effect.gen(function* () {
        if (!(yield* isDaemon(pid))) return false;
        // A daemon stops cleanly on SIGTERM; Pi Durable resumes its interrupted runs in the next one.
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          return true;
        }
        yield* Effect.sync(() => isAlive(pid)).pipe(
          Effect.repeat({ schedule: Schedule.spaced('50 millis'), while: (alive) => alive }),
          Effect.timeoutOrElse({
            duration: stopMs,
            orElse: () => Effect.fail(failure('still-stopping')),
          }),
        );
        return true;
      });

    /** Starts a daemon and waits until its endpoint names it, which it writes once listening. */
    const start = Effect.gen(function* () {
      yield* fs
        .makeDirectory(directory, { mode: 0o700 })
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === 'AlreadyExists'
              ? Effect.void
              : Effect.fail(failure('data-folder')),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner
            .spawn(
              ChildProcess.make(command.command, command.args, {
                cwd: command.cwd,
                env: command.env,
                extendEnv: false,
                detached: true,
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                killSignal: 'SIGTERM',
                forceKillAfter: startGrace,
              }),
            )
            .pipe(Effect.mapError(() => failure('spawn-failed')));
          const listening = readEndpoint.pipe(
            Effect.repeat({
              schedule: Schedule.spaced('25 millis'),
              until: (endpoint) => Option.isSome(endpoint) && endpoint.value.pid === child.pid,
            }),
            Effect.as('listening' as const),
          );
          // Another daemon may hold the directory's lock; then that one is the daemon to use.
          const exited = Effect.as(Effect.exit(child.exitCode), 'exited' as const);
          const outcome = yield* Effect.raceFirst(listening, exited).pipe(
            Effect.timeoutOrElse({
              duration: startMs,
              orElse: () => Effect.fail(failure('start-timeout')),
            }),
          );
          if (outcome === 'exited') {
            // Only a running daemon of this directory that speaks this protocol, not a reused ID.
            const endpoint = yield* readEndpoint;
            if (
              Option.isSome(endpoint) &&
              endpoint.value.protocol === chatProtocolVersion &&
              isAlive(endpoint.value.pid) &&
              (yield* isDaemon(endpoint.value.pid))
            )
              return yield* adopt(endpoint.value);
            return yield* Effect.fail(failure('stopped-while-starting'));
          }
          // It listens: from here it outlives the start, and the app.
          // Node's unref can't fail.
          yield* Effect.orDie(child.unref);
          yield* Ref.set(state, { pid: child.pid, child, outdated: false });
        }),
      );
    });

    /**
     * Makes sure a daemon this app can use runs: the one `endpoint.json` names if it is alive and
     * speaks this protocol (outdated if another build), else a new one.
     */
    const find = Effect.gen(function* () {
      const endpoint = yield* readEndpoint;
      if (Option.isSome(endpoint) && isAlive(endpoint.value.pid)) {
        if (endpoint.value.protocol === chatProtocolVersion) return yield* adopt(endpoint.value);
        // An older app's daemon may be running its agents; it exits once idle with nobody connected.
        if (yield* isDaemon(endpoint.value.pid)) return yield* Effect.fail(failure('older-daemon'));
      }
      yield* start;
    });

    return {
      directory,
      /** The process of the daemon last found or started. */
      pid: Effect.map(Ref.get(state), (running) => running?.pid),
      /** Whether the daemon last found or started is still running. */
      isRunning: Effect.flatMap(Ref.get(state), (running) => {
        if (!running) return Effect.succeed(false);
        if (!running.child) return Effect.sync(() => isAlive(running.pid));
        return Effect.orElseSucceed(running.child.isRunning, () => false);
      }),
      /** Whether the daemon in use is of another build, to be replaced once it has no work. */
      isOutdated: Effect.map(Ref.get(state), (running) => running?.outdated ?? false),
      find,
      /** Starts a new daemon even though one seems to run, for a daemon that stopped answering. */
      start,
      /**
       * Stops the daemon of this directory (`SIGTERM`, so its runs resume in the next one), whether
       * or not it is outdated or busy, and waits for it: the one in use, else the one its endpoint
       * names, an older protocol's included, once its command line shows it is a daemon of this
       * directory. False, signalling nothing, when no process runs a daemon here.
       */
      stop: Effect.gen(function* () {
        const running =
          (yield* Ref.get(state))?.pid ?? Option.getOrUndefined(yield* readEndpoint)?.pid;
        return running !== undefined && (yield* stopDaemon(running));
      }),
      /** Stops the outdated daemon in use, which reported no work, and starts this app's. */
      replace: Effect.gen(function* () {
        const running = yield* Ref.get(state);
        if (!running?.outdated) return;
        // Its endpoint still names a process that isn't the daemon; this app's starts instead.
        if (yield* stopDaemon(running.pid)) yield* find;
        else yield* start;
      }),
    };
  });
export type DaemonProcess = Effect.Success<ReturnType<typeof makeDaemonProcess>>;
