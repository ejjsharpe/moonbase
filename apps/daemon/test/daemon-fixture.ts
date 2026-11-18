import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Cause,
  type Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
  Stream,
} from 'effect';
import type { ChatTarget } from '@moonbase/contracts/chat';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import { EndpointConnectionLive, RemoteDaemonLive } from '@moonbase/daemon-protocol/remote';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import * as BunServices from '@effect/platform-bun/BunServices';
import { TestClock } from 'effect/testing';
import { runDaemon, type DaemonExit, type DaemonOptions } from '../src/daemon.ts';
import { argumentsConfig } from '../src/daemon-config.ts';
import { createFauxProviders } from './faux-provider.ts';

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw Error('Condition did not settle.');
    await delay(20);
  }
}
export async function bounded<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Did not settle in time.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A new parent folder; the daemon's data directory is `data` inside it. */
export async function temporaryRoot() {
  return realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-')));
}

const entries = {
  faux: new URL('./faux-daemon.ts', import.meta.url).pathname,
  main: new URL('../src/main.ts', import.meta.url).pathname,
};
const noNetwork = new URL('./no-network.ts', import.meta.url).pathname;

export type DaemonProcess = ReturnType<typeof startDaemon>;
/** Runs `run` in a new root, then kills the daemons it started and removes the root. */
export async function withRoot(run: (root: string, started: DaemonProcess[]) => Promise<void>) {
  const root = await temporaryRoot(),
    started: DaemonProcess[] = [];
  try {
    await run(root, started);
  } finally {
    await Promise.all(started.map((daemon) => daemon.stop('SIGKILL')));
    await rm(root, { recursive: true, force: true });
  }
}
/**
 * Starts a daemon on this Bun, with provider network refused. `entry` is the faux or real source
 * entry, or the absolute path of a built bundle.
 */
export function startDaemon(
  args: string[],
  {
    entry = 'faux',
    env = {},
  }: { entry?: keyof typeof entries | (string & {}); env?: Record<string, string> } = {},
) {
  const path = entry in entries ? entries[entry as keyof typeof entries] : entry;
  const child = spawn(
    process.execPath,
    // As the app runs it: no `.env`, `bunfig.toml` or auto-install.
    ['--no-env-file', '--config=/dev/null', '--no-install', '--preload', noNetwork, path, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        ...env,
      },
    },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (errors += bytes));
  // 'close', not 'exit': a daemon that stops at once must still have its ready line read first.
  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = new Promise<{ port: number; host: { hostId: string; storeId: string } }>(
    (resolve, reject) => {
      const data = () => {
        const line = output.split('\n').find((text) => text.includes('"event":"ready"'));
        if (!line) return;
        child.stdout.off('data', data);
        resolve(JSON.parse(line));
      };
      child.stdout.on('data', data);
      void exited.then(() => reject(Error('Daemon exited before ready: ' + errors)));
    },
  );
  ready.catch(() => {});
  return {
    child,
    exited,
    ready,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      try {
        return await bounded(exited);
      } catch {
        child.kill('SIGKILL');
        return await bounded(exited);
      }
    },
  };
}

/**
 * A faux client of the daemon's RPC. Each call runs on a connection of its own, and each watch
 * holds one until it closes, so neither keeps the daemon in use afterwards. A call rejects with
 * the tagged error it failed with.
 */
export function createFauxClient(port: number, token: string, host: ChatHostTarget) {
  const origin = `http://127.0.0.1:${port}`;
  const open = () =>
    ManagedRuntime.make(
      RemoteDaemonLive({ host, sameMachine: true, openUrl: async () => {} }).pipe(
        Layer.provideMerge(EndpointConnectionLive({ origin, token, expected: host })),
      ),
    );
  /** Runs `effect` on a connection of its own. */
  async function once<A>(effect: Effect.Effect<A, unknown, ChatService | LocalHostService>) {
    const runtime = open();
    try {
      return await runtime.runPromise(effect);
    } finally {
      await runtime.dispose();
    }
  }
  /** A chat operation on a connection of its own. */
  const chat = <A>(use: (chat: ChatService['Service']) => Effect.Effect<A, unknown>) =>
    once(Effect.flatMap(ChatService, use));
  /** A daemon operation on a connection of its own. */
  const daemon = <A>(use: (host: LocalHostService['Service']) => Effect.Effect<A, unknown>) =>
    once(Effect.flatMap(LocalHostService, use));
  /** Opens a watch and resolves once its first update arrives; `close` ends it. */
  async function watch(target: ChatTarget) {
    const runtime = open(),
      first = Promise.withResolvers<void>();
    const fiber = runtime.runFork(
      Effect.flatMap(ChatService, (chat) =>
        Stream.runForEach(chat.watch({ target }), () => Effect.sync(() => first.resolve())),
      ).pipe(Effect.tapCause((cause) => Effect.sync(() => first.reject(Cause.squash(cause))))),
    );
    try {
      await first.promise;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    return {
      close: async () => {
        await runtime.runPromise(Fiber.interrupt(fiber));
        await runtime.dispose();
      },
    };
  }
  return { origin, chat, daemon, watch };
}

/** Sends a health probe signed with `token`, as a client checks the host before connecting. */
export function probeHealth(origin: string, token: string) {
  const nonce = randomBytes(32).toString('base64url');
  const proof = createHmac('sha256', token)
    .update(JSON.stringify(['moonbase-daemon-health-v1', 'request', nonce]))
    .digest('hex');
  return fetch(origin + '/v1/health', {
    headers: { 'X-Moonbase-Nonce': nonce, Authorization: 'Moonbase-HMAC-SHA256 ' + proof },
  });
}

/** A port free right now on 127.0.0.1, for a host-mode daemon's configured port. */
export async function findFreePort() {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const value = (server.address() as { port: number }).port;
      server.close(() => resolve(value));
    });
  });
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

/**
 * A `TestClock` for a daemon's idle wait, and nothing else of it: `advance` moves its time and
 * runs the waits that come due.
 */
export function createTestClock() {
  const clock = Effect.runSync(TestClock.make().pipe(Scope.provide(Scope.makeUnsafe())));
  return {
    clock: clock as unknown as Clock.Clock,
    advance: (ms: number) => Effect.runPromise(clock.adjust(ms)),
  };
}
export type IdleTestClock = ReturnType<typeof createTestClock>;

/**
 * Runs a daemon in this process on Bun's services, with `directory` as its one argument (or with
 * the arguments given). `exit`
 * settles with the daemon's exit: its reason, or its failure as thrown; `stop` interrupts it as a
 * signal does and waits for it to finish.
 */
export function runInProcess(
  directory: string | readonly string[],
  options: Omit<DaemonOptions, 'closeClaudeCode' | 'ready'> & {
    ready?: (line: string) => void;
    closeClaudeCode?: () => Promise<void> | void;
  },
) {
  const fiber = Effect.runFork(
    runDaemon({
      ...options,
      ready: (line) => Effect.sync(() => options.ready?.(line)),
      closeClaudeCode: Effect.promise(async () => options.closeClaudeCode?.()),
    }).pipe(
      Effect.provide(
        Layer.merge(
          BunServices.layer,
          argumentsConfig(typeof directory === 'string' ? [directory] : directory),
        ),
      ),
    ),
  );
  const exit = Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) return 'stopped' as const;
    throw Cause.squash(exit.cause);
  });
  return {
    exit,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
      return exit;
    },
  };
}

/**
 * Runs a local-mode daemon in this process with faux providers, its idle wait on `time`, and
 * resolves once it is ready. `stop` interrupts it and waits for it to finish.
 */
export async function startInProcess(
  root: string,
  time: IdleTestClock,
  { closeClaudeCode }: { closeClaudeCode?: () => Promise<void> } = {},
) {
  const directory = join(root, 'data');
  const listening = Promise.withResolvers<number>();
  let settled: DaemonExit | Error | undefined;
  const daemon = runInProcess(directory, {
    ready: (line) => listening.resolve(JSON.parse(line).port),
    ...(closeClaudeCode ? { closeClaudeCode } : {}),
    providers: () => createFauxProviders(directory),
    idleClock: time.clock,
  });
  const running = daemon.exit.then(
    (exit) => (settled = exit),
    (error: Error) => (settled = error),
  );
  const port = await Promise.race([
    listening.promise,
    running.then(() => Promise.reject(Error('The daemon stopped before it was ready.'))),
  ]);
  const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
    identity = await readJson(join(directory, 'identity.json'));
  return {
    directory,
    port,
    client: createFauxClient(port, token, identity.host),
    session: { host: identity.host, actorId: identity.actorId },
    get settled() {
      return settled;
    },
    running,
    stop: async () => {
      await daemon.stop().catch(() => {});
      return running;
    },
  };
}

/**
 * The services a privileged process composes over a loopback connection to `directory`; with
 * `sameMachine` false, they stand in for a remote client whose browser is on another machine.
 * `run` runs an effect on their runtime, rejecting with the tagged error it failed with.
 */
export async function connectClients(
  directory: string,
  host: { hostId: string; storeId: string },
  sameMachine = true,
) {
  const opened: string[] = [];
  const runtime = ManagedRuntime.make(
    RemoteDaemonLive({
      host,
      sameMachine,
      openUrl: async (url) => {
        opened.push(url);
      },
    }).pipe(Layer.provideMerge(LoopbackConnectionLive({ directory }))),
  );
  const services = await runtime
    .runPromise(
      Effect.all({
        chat: ChatService,
        connection: ConnectionService,
        providers: ProviderSetupService,
        folders: LocalHostService,
      }),
    )
    .catch(async (error: unknown) => {
      await runtime.dispose();
      throw error;
    });
  return {
    runtime,
    opened,
    ...services,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    /** Follows `stream`, handing each value to `onValue`, until the close it returns. */
    watch: <A, E>(stream: Stream.Stream<A, E>, onValue: (value: A) => void) => {
      const fiber = runtime.runFork(
        Stream.runForEach(stream, (value) => Effect.sync(() => onValue(value))),
      );
      return async () => {
        await runtime.runPromise(Fiber.interrupt(fiber));
      };
    },
  };
}
