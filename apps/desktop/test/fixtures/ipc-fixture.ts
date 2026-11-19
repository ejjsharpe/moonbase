import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  PubSub,
  Queue,
  Scope,
  Stream,
} from 'effect';
import type {
  ChatServiceShape,
  ConnectionServiceShape,
  ProviderSetupService,
  WorkspaceServiceShape,
} from '@moonbase/contracts/services';
import type {
  ChatCommand,
  ChatListUpdate,
  ChatSession,
  ChatSnapshot,
  ChatTarget,
} from '@moonbase/contracts/chat';
import type { ConnectionCommand, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { isKnownError } from '@moonbase/contracts/error-groups';
import { CancelledError } from '@moonbase/contracts/errors';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import type { ChatServiceError } from '@moonbase/contracts/services';
import type { MessagePortLike } from '../../src/ipc/port-socket.ts';
import type { WindowAction } from '../../src/ipc/window-rpcs.ts';
import type { WindowFailure } from '../../src/ipc/ipc-errors.ts';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  makeDocumentHandlers,
  type DocumentHandlersOptions,
} from '../../src/main/ipc/document-handlers.ts';
import type { ChatIpcOptions } from '../../src/main/ipc/chat-ipc.ts';
import type { ChatBackends, ChatTargetClients } from '../../src/main/chat/chat-backends.ts';
import { makeChatDocuments, type ChatDocumentOptions } from '../../src/main/chat/chat-document.ts';
import { EditorApprovals } from '../../src/main/ipc/editor-approvals.ts';
import type { EditorIpcOptions } from '../../src/main/ipc/editor-ipc.ts';
import { makeIpcServer } from '../../src/main/ipc/ipc-server.ts';
import type { NativeActions } from '../../src/main/native-actions.ts';
import { makeChatTargetPorts } from '../../src/renderer/ipc/chat-target-ports.ts';
import { DesktopNative, type DesktopNativeShape } from '../../src/renderer/ipc/desktop-native.ts';
import { callEffect } from '../../src/renderer/ipc/ipc-failures.ts';
import { makeWindowActions } from '../../src/renderer/ipc/window-actions.ts';
import { makeDesktopIpcLayer, toMessagePortLike } from '../../src/renderer/ipc/desktop-ipc.ts';
import { WorkspaceIpcLive } from '../../src/renderer/ipc/workspace-ipc.ts';
import { forkWorkspace, makeWorkspaceRunner } from './workspace-client-fixture.ts';

/** A test's callback watch as a stream, closed (ignoring a close failure) when the stream ends. */
export const watched = <A, E = never>(
  watch: (receive: (value: A) => void, fail: (error: E) => void) => () => unknown,
) =>
  Stream.callback<A, E>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        watch(
          (value) => void Queue.offerUnsafe(queue, value),
          (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
        ),
      ),
      (close) => Effect.promise(async () => close()).pipe(Effect.ignore),
    ),
  );
/**
 * `partial` as a whole service: each method a test leaves out dies, as not part of the test (a
 * `watch…` one as a stream).
 */
export const fakeService = <S extends object>(name: string, partial: Partial<S> = {}): S =>
  new Proxy(partial, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined;
      const value = Reflect.get(target, key);
      if (value !== undefined) return value;
      const unused = `${name}'s ${key} is not part of this test.`;
      return key.startsWith('watch') ? () => Stream.die(unused) : () => Effect.die(unused);
    },
  }) as S;
/** A test's Promise fake of a chat service, as tests that hold replies write one. */
export type FakeChat = {
  command(
    operation: ChatCommand,
    input: unknown,
    options: { signal?: AbortSignal },
  ): Promise<never>;
  watch?(
    input: { target: ChatTarget },
    receive: (snapshot: ChatSnapshot) => void,
    fail: (error: unknown) => void,
  ): () => Promise<void>;
  watchChatList?(
    input: { session: ChatSession },
    receive: (update: ChatListUpdate) => void,
    fail: (error: unknown) => void,
  ): () => Promise<void>;
};
/** A fake's failure as a service's: one of contracts' errors as it is, anything else unavailable. */
const asServiceError = (error: unknown) =>
  isKnownError(error)
    ? (error as ChatServiceError)
    : new HostUnavailableError({ reason: 'failed' });
/** The chat service main calls, over a test's Promise fake. */
export const toChatService = (fake: FakeChat): Partial<ChatServiceShape> =>
  new Proxy({} as Partial<ChatServiceShape>, {
    get: (_, name: string) => {
      if (name === 'watch' || name === 'watchChatList') {
        const watch = fake[name];
        return watch
          ? (input: never) =>
              watched<unknown, unknown>((receive, fail) =>
                watch(input, receive as never, fail),
              ).pipe(Stream.mapError(asServiceError))
          : undefined;
      }
      return (input: never) =>
        Effect.tryPromise({
          try: (signal) => fake.command(name as ChatCommand, input, { signal }),
          catch: asServiceError,
        });
    },
  });
/** A test's Promise fake of the remote connection. */
export type FakeConnection = {
  command(
    operation: ConnectionCommand,
    input: unknown,
    options: { signal?: AbortSignal },
  ): Promise<never>;
  watch(
    receive: (snapshot: ConnectionSnapshot) => void,
    fail: (error: unknown) => void,
  ): () => Promise<void>;
};
/** The remote connection main calls, over a test's Promise fake. */
export const toConnectionService = (fake: FakeConnection): Partial<ConnectionServiceShape> =>
  new Proxy({} as Partial<ConnectionServiceShape>, {
    get: (_, name: string) =>
      name === 'watch'
        ? () =>
            watched<ConnectionSnapshot, unknown>((receive, fail) => fake.watch(receive, fail)).pipe(
              Stream.mapError(asServiceError),
            )
        : (input: never) =>
            Effect.tryPromise({
              try: (signal) => fake.command(name as ConnectionCommand, input, { signal }),
              catch: asServiceError,
            }),
  });
type ProviderSetup = ProviderSetupService['Service'];
/** A test's fakes of one chat target, as main reaches them. */
export type FakeChatTarget = {
  chat: Partial<ChatServiceShape>;
  context: ChatSession;
  providers?: Partial<ProviderSetup>;
  connection?: Partial<ConnectionServiceShape>;
};
/** Chat backends whose targets are `targets`' fakes, as their clients reach main. */
export const fakeChatTargets = (
  targets: Partial<Record<'local' | 'remote', FakeChatTarget>>,
): Pick<ChatIpcOptions['backends'], 'targets' | 'findTarget'> => {
  const clients = Object.fromEntries(
    Object.entries(targets).map(([id, target]) => [
      id,
      {
        chat: fakeService('The chat', target.chat),
        context: target.context,
        providers: fakeService<ProviderSetup>('Provider setup', {
          releaseOwner: () => Effect.void,
          ...target.providers,
        }),
        connection: target.connection ? fakeService('The connection', target.connection) : null,
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
export const unusedNative: NativeActions = {
  chooseCheckout: Effect.die('The picker is not part of this test.'),
  chooseFolder: Effect.die('The picker is not part of this test.'),
  surfacePickers: Effect.void,
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

/** How long a test waits for a condition or a port before it fails. */
const testDeadline = 15_000;
/** Polls `check`, awaiting it, until it holds, failing if it never does. */
export async function waitFor(check: () => unknown) {
  const deadline = Date.now() + testDeadline;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error('The condition never held: ' + String(check));
}
/** `promise`'s outcome, or a failure naming `what` if it never settles. */
export async function settleWithin<A>(promise: Promise<A>, what: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(what + ' never settled')), testDeadline);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
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
 * message ports: the same procedures, schemas, admission, ports and clients the app uses.
 */
export async function makeIpcFixture(
  options: {
    editor?: Partial<Omit<EditorIpcOptions, 'workspace'>> & {
      workspace?: Partial<WorkspaceServiceShape>;
    };
    chat?: Partial<Omit<DocumentHandlersOptions['chat'], 'documents' | 'backends'>> & {
      backends?: Partial<ChatIpcOptions['backends']>;
      releaseOwner?: ChatBackends['releaseOwner'];
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
            workspace: fakeService('The workspace', options.editor?.workspace),
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
        Layer.merge(
          WorkspaceIpcLive,
          DesktopNative.layer({ connect: async () => {}, pathForFile: (file) => file.name }),
        ),
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
    /** Runs `use` of the renderer's `WorkspaceService`, as the editor calls main. */
    workspace: ((use, callOptions) =>
      makeWorkspaceRunner(renderer)(use, callOptions)) as ReturnType<typeof makeWorkspaceRunner>,
    /** Forks `use` (a watch, say) of the renderer's workspace; the returned close interrupts it. */
    forkWorkspace: <A, E>(use: (workspace: WorkspaceServiceShape) => Effect.Effect<A, E>) =>
      forkWorkspace(renderer, use),
    /** Main's native and window procedures as the renderer calls them, each run to a Promise. */
    get shell() {
      const native = <A, E>(use: (native: DesktopNativeShape) => Effect.Effect<A, E>) =>
        renderer.runPromise(Effect.flatMap(DesktopNative, use));
      const window = makeWindowActions();
      return {
        chatTargets: () =>
          renderer.runPromise(callEffect('getChatTargets', undefined, 'desktop-request')),
        chooseChatFolder: () => native((n) => n.chooseChatFolder),
        chooseCheckout: () => native((n) => n.chooseCheckout),
        createChatWorktree: (root: string, branch: string, requestId: string) =>
          native((n) => n.createChatWorktree(root, branch, requestId)),
        pasteImports: (checkout: CheckoutTarget) => native((n) => n.pasteImports(checkout)),
        dropImports: (checkout: CheckoutTarget, files: File[]) =>
          native((n) => n.dropImports(checkout, files)),
        copyPaths: (checkout: CheckoutTarget, paths: string[], relative: boolean) =>
          native((n) => n.copyPaths(checkout, paths, relative)),
        revealPath: (checkout: CheckoutTarget, path: string) =>
          native((n) => n.revealPath(checkout, path)),
        /** Watches main's window actions; the returned close interrupts the watch. */
        watchWindowActions: (receive: (action: WindowAction) => void) => {
          const watching = renderer.runFork(window.watch(receive));
          return () => renderer.runPromise(Fiber.interrupt(watching)).then(() => undefined);
        },
        answerQuit: (id: string, consent: boolean, cleanupError?: WindowFailure) =>
          renderer.runPromise(window.answerQuit(id, consent, cleanupError)),
      };
    },
    /**
     * One chat target's transcript native actions, each run to a Promise that rejects with its
     * failure, or a `CancelledError` once `signal` aborts.
     */
    target: (id: 'local' | 'remote') => {
      type Transcript = DesktopNativeShape['transcripts']['local'];
      const transcript = async <A, E>(
        use: (native: Transcript) => Effect.Effect<A, E>,
        operation: string,
        signal?: AbortSignal,
      ) => {
        const exit = await renderer.runPromiseExit(
          Effect.flatMap(DesktopNative, (n) => use(n.transcripts[id])),
          { signal },
        );
        if (Exit.isSuccess(exit)) return exit.value;
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === 'Some') throw failure.value;
        throw Cause.hasInterruptsOnly(exit.cause)
          ? new CancelledError({ operation })
          : Cause.squash(exit.cause);
      };
      return {
        transcript: {
          copy: (input: Parameters<Transcript['copy']>[0], signal?: AbortSignal) =>
            transcript((t) => t.copy(input), 'copyTranscript', signal),
          openLink: (url: string, signal?: AbortSignal) =>
            transcript((t) => t.openLink(url), 'openTranscriptLink', signal),
          imageUrl: (image: Parameters<Transcript['imageUrl']>[0], signal?: AbortSignal) =>
            transcript((t) => t.imageUrl(image), 'getTranscriptImageUrl', signal),
        },
      };
    },
    /** The chat, provider setup and connection ports the renderer's chat runs on, for `id`. */
    ports: (id: 'local' | 'remote') => renderer.runPromise(makeChatTargetPorts(id)),
    connectRaw,
    /** Closes every connection from main's end, as a refused message does; the document stays. */
    closeConnections() {
      for (const port of mainPorts) port.close();
      mainPorts.clear();
    },
    /** Takes main's document out of the window, as a navigation does; the result releases it. */
    detachDocument: server.detachDocument,
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
