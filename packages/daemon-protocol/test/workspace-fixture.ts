import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream, type Cause } from 'effect';
import { TestClock } from 'effect/testing';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import {
  ConnectionService,
  WorkspaceHostService,
  type VerifiedChatEndpoint,
  type WorkspaceHostServiceShape,
} from '@moonbase/contracts/services';
import type { WorkspaceEvent } from '@moonbase/contracts/workspace';
import type { HostCommand } from '@moonbase/contracts/workspace-host';
import {
  isWorkspaceHostError,
  WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import { RemoteWorkspaceHostLive } from '../src/client/remote-workspace.ts';
import { serveChat, type ChatServerOptions } from '../src/server/server.ts';
import { controlledChat, host, nonce } from './controlled-chat-fixture.ts';
import { refusingDaemon } from './served-services.ts';

export const checkout = {
  vcs: 'none',
  hostId: host.hostId,
  checkoutId: 'checkout-1',
  projectId: 'project-1',
  root: '/work',
} as const;
export const foreign = { ...checkout, hostId: 'other-host' } as const;
export const fileTarget = { checkout, path: 'a.txt' };
export const identity = { installationId: 'install', clientId: 'client' };
export const saveInput = (text: string, requestId = 'save-1') => ({
  ...identity,
  requestId,
  target: fileTarget,
  text,
  expectedVersion: 'v0',
});

type Handler = (input: never, signal: AbortSignal) => Promise<unknown>;
/**
 * A file host whose operations the test answers: each runs its handler with an abort signal that
 * fires when the daemon interrupts it, and an unanswered one fails. Its watches are queues the
 * test feeds.
 */
export function controlledWorkspace() {
  const handlers: Partial<Record<HostCommand, Handler>> = {},
    calls: HostCommand[] = [],
    interrupted: HostCommand[] = [],
    watchers = new Set<Queue.Queue<WorkspaceEvent, Cause.Done>>();
  const service = new Proxy({} as WorkspaceHostServiceShape, {
    get: (_, name: string) => {
      if (name === 'watch')
        return () =>
          Stream.callback<WorkspaceEvent>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                watchers.add(queue);
                Queue.offerUnsafe(queue, { checkout, paths: [], ready: true });
              }),
              () => Effect.sync(() => void watchers.delete(queue)),
            ),
          );
      const operation = name as HostCommand;
      return (input: never) =>
        Effect.tryPromise({
          try: (signal) => {
            calls.push(operation);
            signal.addEventListener('abort', () => interrupted.push(operation));
            const handler = handlers[operation];
            if (!handler) throw new WorkspaceUnavailableError({ cause: 'failed' });
            return handler(input, signal);
          },
          catch: (error) =>
            isWorkspaceHostError(error)
              ? error
              : new WorkspaceUnavailableError({ cause: 'failed' }),
        });
    },
  });
  return {
    service,
    handlers,
    calls,
    interrupted,
    watchers,
    /** Reports a change to every open watch. */
    change: () => {
      for (const queue of watchers) Queue.offerUnsafe(queue, { checkout, paths: [''] });
    },
    /** Ends every open watch, as a host's watch that finishes. */
    end: () => {
      for (const queue of watchers) Queue.endUnsafe(queue);
    },
  };
}

/**
 * A daemon serving `workspace` (none when absent) and a controlled chat, which can stop and start
 * again on its port; its time is a `TestClock` the test moves with `advance`.
 */
export async function serveWorkspace(
  t: { after(run: () => unknown): void },
  workspace?: WorkspaceHostServiceShape,
  options: Pick<ChatServerOptions, 'closeMs' | 'onCloseTimeout'> = {},
) {
  const token = nonce(),
    chat = controlledChat(),
    runtime = ManagedRuntime.make(TestClock.layer());
  let scope: Scope.Closeable | undefined,
    port = 0;
  /** Starts the daemon; `closeRpcFirst` orders how it closes when next stopped. */
  const start = async (order: Pick<ChatServerOptions, 'closeRpcFirst'> = {}) => {
    scope = Effect.runSync(Scope.make());
    const server = await runtime.runPromise(
      serveChat(
        { host, token, port },
        { chat: chat.client, daemon: refusingDaemon() },
        { ...options, ...order, ...(workspace ? { workspace } : {}) },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    port = Number(new URL(server.origin).port);
  };
  const stop = async () => {
    const closing = scope;
    scope = undefined;
    // On the server's clock, so its close deadline moves with `advance`.
    if (closing) await runtime.runPromise(Scope.close(closing, Exit.void));
  };
  await start();
  t.after(stop);
  t.after(() => runtime.dispose());
  return {
    token,
    chat,
    start,
    stop,
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    get port() {
      return port;
    },
    get endpoint() {
      return { origin: `http://127.0.0.1:${port}`, token, expected: host };
    },
  };
}

/**
 * A `RemoteWorkspaceHostLive` client of `daemon`, over a connection whose generation the test may
 * replace; its time is a `TestClock` the test moves with `advance` when `testClock` is set.
 */
export async function remoteWorkspace(
  t: { after(run: () => unknown): void },
  daemon: { endpoint: { origin: string; token: string; expected: typeof host } },
  testClock = false,
) {
  let connectionId = nonce();
  const changes = new Set<() => void>();
  const endpoint = (): VerifiedChatEndpoint => ({
    ...daemon.endpoint,
    connectionId,
    health: { ...host, protocol: chatProtocolVersion, version: '0.1.0', capabilities: [] },
  });
  const connection = Layer.succeed(ConnectionService, {
    getConnection: () => Effect.die('unused'),
    connect: () => Effect.die('unused'),
    disconnect: () => Effect.die('unused'),
    watch: () =>
      Stream.callback<ConnectionSnapshot>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const publish = () =>
              void Queue.offerUnsafe(queue, { state: 'connected', connectionId } as never);
            changes.add(publish);
            return publish;
          }),
          (publish) => Effect.sync(() => void changes.delete(publish)),
        ),
      ),
    endpoint: () => Effect.sync(endpoint),
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteWorkspaceHostLive({ host }),
      ...(testClock ? [TestClock.layer()] : []),
    ).pipe(Layer.provide(connection)),
  );
  t.after(() => runtime.dispose());
  return {
    workspace: await runtime.runPromise(WorkspaceHostService),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    fork: <A, E>(effect: Effect.Effect<A, E>) => runtime.runFork(effect),
    advance: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    /** Replaces the connection generation and announces it, as a reconnect through SSH does. */
    replace() {
      connectionId = nonce();
      for (const publish of changes) publish();
    },
  };
}
