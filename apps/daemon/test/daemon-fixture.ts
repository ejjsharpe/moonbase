import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Effect, Layer, ManagedRuntime } from 'effect';
import type { ChatCommand, ChatInput, ChatOutput, ChatTarget } from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { LocalHostService, ProviderSetupService } from '@moonbase/contracts/services';
import {
  makeChatClient,
  makeConnectionClient,
  makeProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/daemon-protocol/remote';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import { connectDaemonSocket } from '@moonbase/daemon-protocol/socket';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { runDaemon, type DaemonExit } from '../src/daemon.ts';
import type { IdleClock } from '../src/idle.ts';
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
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
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
 * A faux client of the daemon's WebSocket. Each command runs on a connection of its own, and each
 * watch holds one until it closes, so neither keeps the daemon in use afterwards.
 */
export function createFauxClient(port: number, token: string, host: ChatHostTarget) {
  const origin = `http://127.0.0.1:${port}`;
  const connect = () => connectDaemonSocket({ origin, token, expected: host });
  async function command<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
  ): Promise<ChatOutput<K>> {
    const socket = await connect();
    try {
      return (await socket.request(operation, input as never)) as ChatOutput<K>;
    } finally {
      await socket.close();
    }
  }
  /** Opens a watch and resolves once its first update arrives; `close` ends it. */
  async function watch(target: ChatTarget) {
    const socket = await connect(),
      first = Promise.withResolvers<void>();
    socket.subscribe('chat', target, { receive: () => first.resolve(), onError: first.reject });
    try {
      await first.promise;
    } catch (error) {
      await socket.close();
      throw error;
    }
    return { close: () => socket.close() };
  }
  return { origin, command, watch };
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

/** A clock whose time moves only when the test advances it; due timers then fire in order. */
export function createControlledClock() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: IdleClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      timers.set(++next, { at: now + ms, callback });
      return next;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };
  return {
    clock,
    get pending() {
      return timers.size;
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // The check reads active work from the real store before it decides.
        await delay(40);
      }
      now = end;
      await delay(40);
    },
  };
}

export type ControlledClock = ReturnType<typeof createControlledClock>;

/**
 * Runs a local-mode daemon in this process with faux providers, on `time`'s clock, and resolves
 * once it is ready. `stop` aborts it and waits for it to finish.
 */
export async function startInProcess(
  root: string,
  time: ControlledClock,
  { closeClaudeCode = async () => {} }: { closeClaudeCode?: () => Promise<void> } = {},
) {
  const directory = join(root, 'data'),
    controller = new AbortController();
  let ready!: (port: number) => void;
  const listening = new Promise<number>((resolve) => (ready = resolve));
  let settled: DaemonExit | Error | undefined;
  const running = runDaemon({
    directory,
    signal: controller.signal,
    ready: (line) => ready(JSON.parse(line).port),
    closeClaudeCode,
    providers: () => createFauxProviders(directory),
    clock: time.clock,
  }).then(
    (exit) => (settled = exit),
    (error: Error) => (settled = error),
  );
  const port = await listening;
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
      controller.abort();
      return running;
    },
  };
}

/**
 * The clients a privileged process composes over a loopback connection to `directory`; with
 * `sameMachine` false, they stand in for a remote client whose browser is on another machine.
 */
export function connectClients(
  directory: string,
  host: { hostId: string; storeId: string },
  sameMachine = true,
) {
  const opened: string[] = [];
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteChatLive,
      RemoteLocalHostLive,
      RemoteProviderSetupLive({
        host,
        sameMachine,
        openUrl: async (url) => {
          opened.push(url);
        },
      }),
    ).pipe(Layer.provideMerge(LoopbackConnectionLive({ directory }))),
  );
  return {
    runtime,
    opened,
    chat: makeChatClient(runtime),
    connection: makeConnectionClient(runtime),
    owner: (ownerId: string) => makeProviderSetupClient(runtime, ownerId),
    run: <A>(effect: Effect.Effect<A, ApplicationError, LocalHostService | ProviderSetupService>) =>
      runtime.runPromise(effect),
  };
}
