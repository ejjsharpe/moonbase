import { Cause, Effect, Exit, Layer, ManagedRuntime, PubSub, Queue, Scope, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ObservationClose } from '@moonbase/contracts/common';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import type {
  ChatServiceShape,
  ConnectionServiceShape,
  ProviderSetupService,
  WorkspaceServiceShape,
} from '@moonbase/contracts/services';
import type { ChatClient, ChatSession } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import { normalizeApplicationError } from '@moonbase/effect';
import type { WorkspaceCommand, WorkspaceEvent } from '@moonbase/contracts/workspace';
import type { MessagePortLike } from '../../src/ipc/port-socket.ts';
import type { WindowAction } from '../../src/ipc/window-rpcs.ts';
import {
  makeDocumentHandlers,
  type DocumentHandlersOptions,
} from '../../src/main/ipc/document-handlers.ts';
import type { ChatIpcOptions } from '../../src/main/ipc/chat-ipc.ts';
import type { ChatTargetClients } from '../../src/main/chat/chat-backends.ts';
import { makeChatDocuments, type ChatDocumentOptions } from '../../src/main/chat/chat-document.ts';
import { EditorApprovals } from '../../src/main/ipc/editor-approvals.ts';
import type { EditorIpcOptions } from '../../src/main/ipc/editor-ipc.ts';
import { makeIpcServer } from '../../src/main/ipc/ipc-server.ts';
import type { NativeActions } from '../../src/main/native-actions.ts';
import {
  makeChatTargetClients,
  makeShellClients,
} from '../../src/renderer/ipc/application-clients.ts';
import { makeDesktopIpcLayer, toMessagePortLike } from '../../src/renderer/ipc/desktop-ipc.ts';
import { WorkspaceIpcLive } from '../../src/renderer/ipc/workspace-ipc.ts';
import { makeWorkspaceClient, type FakeWorkspaceClient } from './workspace-client-fixture.ts';

export type { FakeWorkspaceClient };

/** A callback watch as a stream, closed (ignoring a close failure) when the stream ends. */
export const watched = <A>(
  watch: (receive: (value: A) => void, fail: (error: ApplicationError) => void) => ObservationClose,
) =>
  Stream.callback<A, ApplicationError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        watch(
          (value) => void Queue.offerUnsafe(queue, value),
          (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
        ),
      ),
      (close) => Effect.promise(() => close().catch(() => {})),
    ),
  );
/** A Promise command as the Effect a service returns, aborted when interrupted. */
const command = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => normalizeApplicationError(error) });
/** The chat service main calls, over a test's Promise fake. */
export const toChatService = (client: ChatClient): ChatServiceShape =>
  new Proxy({} as ChatServiceShape, {
    get: (_, name: string) => {
      if (name === 'watch')
        return (input: Parameters<ChatClient['watch']>[0]) =>
          watched((receive, fail) => client.watch(input, receive as never, fail));
      if (name === 'watchChatList')
        return (input: Parameters<ChatClient['watchChatList']>[0]) =>
          watched((receive, fail) => client.watchChatList(input, receive as never, fail));
      return (input: never) =>
        command((signal) => client.command(name as never, input, { signal }));
    },
  });
/** The provider setup main calls, over a test's Promise fake for every owner. */
export const toProviderService = (
  client: ProviderSetupClient,
): ProviderSetupService['Service'] => ({
  forOwner: () =>
    new Proxy({} as ReturnType<ProviderSetupService['Service']['forOwner']>, {
      get: (_, name: string) => (input: never) =>
        command((signal) => client.command(name as never, input, { signal })),
    }),
  releaseOwner: () => Effect.void,
  watch: () => watched((receive, fail) => client.watch(receive as never, fail)),
  getProviderUrl: () => Effect.die('unused'),
});
/** The remote connection main calls, over a test's Promise fake. */
export const toConnectionService = (client: ConnectionClient): ConnectionServiceShape =>
  new Proxy({} as ConnectionServiceShape, {
    get: (_, name: string) => {
      if (name === 'watch')
        return () => watched((receive, fail) => client.watch(receive as never, fail));
      return (input: never) =>
        command((signal) => client.command(name as never, input, { signal }));
    },
  });
/** A test's fakes of one chat target, as main reaches them. */
export type FakeChatTarget = {
  chat: ChatClient;
  context: ChatSession;
  providers?: ProviderSetupClient;
  connection?: ConnectionClient;
};
const unusedProviders: ProviderSetupClient = {
  command: async () => {
    throw new ApplicationError({
      code: 'Unavailable',
      message: 'Providers are not part of this test.',
    });
  },
  watch: () => async () => {},
};
/** Chat backends whose targets are `targets`' fakes, as their clients reach main. */
export const fakeChatTargets = (
  targets: Partial<Record<'local' | 'remote', FakeChatTarget>>,
): Pick<ChatIpcOptions['backends'], 'targets' | 'findTarget'> => {
  const clients = Object.fromEntries(
    Object.entries(targets).map(([id, target]) => [
      id,
      {
        chat: toChatService(target.chat),
        context: target.context,
        providers: toProviderService(target.providers ?? unusedProviders),
        connection: target.connection ? toConnectionService(target.connection) : null,
      } satisfies ChatTargetClients,
    ]),
  ) as Partial<Record<'local' | 'remote', ChatTargetClients>>;
  return {
    targets: (['local', 'remote'] as const)
      .filter((id) => targets[id])
      .map((id) => ({ id, label: id === 'local' ? 'Local' : 'Host', mode: id })),
    findTarget: (id) => Effect.succeed(clients[id]),
  };
};

/** The `WorkspaceService` main serves, over a test's fake. */
export const toWorkspaceService = (client: FakeWorkspaceClient): WorkspaceServiceShape =>
  new Proxy({} as WorkspaceServiceShape, {
    get: (_, name: string) => {
      if (name === 'watch')
        return (input: Parameters<FakeWorkspaceClient['watch']>[0]) =>
          watched<WorkspaceEvent>((receive, fail) => client.watch(input, receive, fail));
      if (name === 'watchRecovery')
        return (input: { clientId: string }) =>
          watched<RecoveryOutline>((receive, fail) => client.watchRecovery(input, receive, fail));
      return (input: never) =>
        Effect.tryPromise({
          try: (signal) => client.command(name as WorkspaceCommand, input, { signal }),
          catch: (error) => normalizeApplicationError(error),
        });
    },
  });

/** Node's port as main's: Node reports the other end closing as a `close` event, as Electron does. */
const toMainPortLike = (port: MessagePort): MessagePortLike => {
  const like = toMessagePortLike(port);
  return {
    ...like,
    listen(onMessage, onClose) {
      const node = port as unknown as NodeJS.EventEmitter;
      node.once('close', onClose);
      const stop = like.listen(onMessage, () => {});
      return () => {
        node.off('close', onClose);
        stop();
      };
    },
  };
};
const unused = (name: string) => () => {
  throw new ApplicationError({ code: 'Unavailable', message: `${name} is not part of this test.` });
};
export const unusedEditorClient: FakeWorkspaceClient = {
  command: unused('The workspace') as never,
  watch: unused('The workspace watch') as never,
  watchRecovery: unused('The recovery watch') as never,
};
export const unusedNative: NativeActions = {
  chooseCheckout: Effect.die('The picker is not part of this test.'),
  choosePaths: () => Effect.die('Imports are not part of this test.'),
  capture: () => Effect.die('Imports are not part of this test.'),
  release: () => Effect.void,
  copyText: () => Effect.die('The clipboard is not part of this test.'),
  reveal: () => Effect.die('Finder is not part of this test.'),
};
export const noChat: ChatIpcOptions['backends'] = {
  targets: [],
  findTarget: () => Effect.succeed(undefined),
  getContext: () => Effect.die('Chat is not part of this test.'),
  chooseFolder: Effect.die('The folder picker is not part of this test.'),
  recentFolders: () => Effect.succeed([]),
  createWorktree: () => Effect.die('Worktrees are not part of this test.'),
  turnIntoProject: () => Effect.die('Projects are not part of this test.'),
};

/** Polls `check` until it holds, failing if it never does. */
export async function waitFor(check: () => unknown) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error('The condition never held: ' + String(check));
}
/** One request's outcome on the wire: its value, its failure, or a refusal of its frame. */
export type RawReply = {
  ok: boolean;
  value?: unknown;
  error?: { _tag: string; [field: string]: unknown };
};
/** A raw connection to the server: frames in and out, as a renderer that ignores the client. */
export type RawConnection = {
  send(message: unknown): void;
  /** The next frame main sends, parsed. */
  next(): Promise<Record<string, unknown>>;
  closed: Promise<void>;
  close(): void;
};

/**
 * Main's IPC server for one window, with test doubles, and the renderer's clients of it over Node
 * message ports: the same procedures, schemas, admission and Promise clients the app uses.
 */
export async function makeIpcFixture(
  options: {
    editor?: Partial<Omit<EditorIpcOptions, 'workspace'>> & { client?: FakeWorkspaceClient };
    chat?: Partial<Omit<DocumentHandlersOptions['chat'], 'documents' | 'backends'>> & {
      backends?: Partial<ChatIpcOptions['backends']>;
      releaseOwner?: (ownerId: string) => Effect.Effect<void, ApplicationError>;
      perf?: ChatDocumentOptions['perf'];
    };
    lifecycle?: Partial<DocumentHandlersOptions['lifecycle']>;
    intercept?: DocumentHandlersOptions['intercept'];
  } = {},
) {
  const cleanupFailures: unknown[] = [];
  const reportCleanup = (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => void cleanupFailures.push(Cause.squash(cause)));
  const main = ManagedRuntime.make(Layer.empty);
  const actions = await main.runPromise(PubSub.unbounded<WindowAction>());
  const approvals = options.editor?.approvals ?? new EditorApprovals();
  const scope = Scope.makeUnsafe();
  const { releaseOwner = () => Effect.void, perf, ...chat } = options.chat ?? {};
  const backends = { ...noChat, ...chat.backends };
  const documents = await main.runPromise(
    Scope.provide(
      makeChatDocuments(
        { findTarget: backends.findTarget, releaseOwner },
        { isClosing: Effect.succeed(false), ...(perf ? { perf } : {}) },
      ),
      scope,
    ),
  );
  const server = await main.runPromise(
    Scope.provide(
      makeIpcServer(
        makeDocumentHandlers({
          editor: {
            native: unusedNative,
            localHostId: Effect.succeed('local-host'),
            reportCleanup,
            ...options.editor,
            workspace: toWorkspaceService(options.editor?.client ?? unusedEditorClient),
            approvals,
          },
          chat: { ...chat, backends, documents },
          lifecycle: {
            actions,
            markReady: Effect.void,
            answerQuit: () => Effect.void,
            isQuitting: Effect.succeed(false),
            ...options.lifecycle,
          },
          ...(options.intercept ? { intercept: options.intercept } : {}),
        }),
      ),
      scope,
    ),
  );
  /** Main's ends of the ports it took. */
  const mainPorts = new Set<MessagePort>();
  /** A port pair whose main end the server takes, or undefined when it refuses one. */
  const openPort = async (): Promise<MessagePort | undefined> => {
    const { port1, port2 } = new MessageChannel();
    if (await main.runPromise(server.connect(toMainPortLike(port1)))) {
      mainPorts.add(port1);
      return port2;
    }
    port1.close();
    port2.close();
    return undefined;
  };
  /** The renderer's runtime, a fresh one for each document as a reload would make. */
  const makeRenderer = () =>
    ManagedRuntime.make(
      Layer.provideMerge(
        WorkspaceIpcLive,
        makeDesktopIpcLayer(
          Effect.flatMap(Effect.promise(openPort), (port) =>
            port
              ? Effect.succeed<MessagePortLike>(toMessagePortLike(port))
              : Effect.fail('refused'),
          ),
        ),
      ),
    );
  let renderer = makeRenderer();
  const connectRaw = async (): Promise<RawConnection | undefined> => {
    const port = await openPort();
    if (!port) return undefined;
    const frames: Record<string, unknown>[] = [];
    const waiters: ((frame: Record<string, unknown>) => void)[] = [];
    const closed = Promise.withResolvers<void>();
    port.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data as string) as Record<string, unknown>;
      // Pongs answer the client's pings; nothing here pings.
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    (port as unknown as NodeJS.EventEmitter).once('close', () => closed.resolve());
    port.start();
    return {
      send: (message) =>
        port.postMessage(typeof message === 'string' ? message : JSON.stringify(message)),
      next: () =>
        frames.length
          ? Promise.resolve(frames.shift()!)
          : new Promise((resolve) => waiters.push(resolve)),
      closed: closed.promise,
      close: () => port.close(),
    };
  };
  let raw: RawConnection | undefined;
  let rawId = 0;
  /** Sends one request as raw JSON on a connection of its own kind, and reads its outcome. */
  const call = async (tag: string, payload: unknown): Promise<RawReply> => {
    raw ??= await connectRaw();
    if (!raw) throw Error('The server refused a raw connection.');
    const id = String(rawId++);
    raw.send({ _tag: 'Request', id, tag, payload, headers: [] });
    for (;;) {
      const frame = await raw.next();
      if (frame._tag === 'Defect')
        return { ok: false, error: { _tag: 'Defect', defect: frame.defect } };
      if (frame._tag !== 'Exit' || frame.requestId !== id) continue;
      const exit = frame.exit as {
        _tag: string;
        value?: unknown;
        cause?: Record<string, unknown>[];
      };
      if (exit._tag === 'Success') return { ok: true, value: exit.value };
      const reason = exit.cause!.find((r) => r._tag === 'Fail') ?? exit.cause![0]!;
      return {
        ok: false,
        error:
          reason._tag === 'Fail'
            ? (reason.error as NonNullable<RawReply['error']>)
            : { _tag: reason._tag as string, defect: reason.defect },
      };
    }
  };
  return {
    approvals,
    call,
    actions,
    cleanupFailures,
    /** The current document's transcript image lookup, as the `moonbase:` protocol reads it. */
    findImages: () => main.runPromise(documents.findImages),
    /** Runs `effect` on main's runtime, as main's own work runs. */
    run: <A, E>(effect: Effect.Effect<A, E>) => main.runPromise(effect),
    get editor() {
      return makeWorkspaceClient(renderer);
    },
    get shell() {
      return makeShellClients(renderer, {
        connect: async () => {},
        pathForFile: (file) => file.name,
      });
    },
    target: (id: 'local' | 'remote') => makeChatTargetClients(renderer, id),
    connectRaw,
    /** Closes every connection from main's end, as a refused message does; the document stays. */
    closeConnections() {
      for (const port of mainPorts) port.close();
      mainPorts.clear();
    },
    /** Releases main's document, as a reload does, and starts the renderer's next one. */
    async releaseDocument() {
      raw?.close();
      raw = undefined;
      const old = renderer;
      renderer = makeRenderer();
      // A failed release has no request left to answer with, so main reports it.
      const released = await main.runPromise(Effect.exit(server.releaseDocument));
      if (Exit.isFailure(released)) cleanupFailures.push(Cause.squash(released.cause));
      await old.dispose();
    },
    /** Closes main's server, as Quit does. */
    close: () => main.runPromise(Scope.close(scope, Exit.void)),
    async dispose() {
      raw?.close();
      await renderer.dispose();
      await main.runPromise(Scope.close(scope, Exit.void));
      await main.dispose();
    },
  };
}
export type IpcFixture = Awaited<ReturnType<typeof makeIpcFixture>>;
