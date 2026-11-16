import { Cause, Effect, Layer, ManagedRuntime, PubSub, Queue, Scope, Stream } from 'effect';
import { runApplicationEffect } from '@moonbase/application/chat/promises';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ObservationClose } from '@moonbase/contracts/common';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import type { WorkspaceServiceShape } from '@moonbase/contracts/services';
import { normalizeApplicationError } from '@moonbase/effect';
import type { WorkspaceCommand, WorkspaceEvent } from '@moonbase/contracts/workspace';
import type { MessagePortLike } from '../../src/ipc/port-socket.ts';
import type { WindowAction } from '../../src/ipc/window-rpcs.ts';
import {
  makeDocumentHandlers,
  type DocumentHandlersOptions,
} from '../../src/main/ipc/document-handlers.ts';
import type { ChatIpcOptions } from '../../src/main/ipc/chat-ipc.ts';
import { EditorApprovals } from '../../src/main/ipc/editor-approvals.ts';
import type { EditorIpcOptions } from '../../src/main/ipc/editor-ipc.ts';
import { makeIpcServer } from '../../src/main/ipc/ipc-server.ts';
import type { NativeActions } from '../../src/main/native-actions.ts';
import type { SessionImage } from '../../src/main/chat/session.ts';
import type { TranscriptImageReader } from '../../src/main/chat/transcript-native.ts';
import {
  makeChatTargetClients,
  makeShellClients,
} from '../../src/renderer/ipc/application-clients.ts';
import { makeDesktopIpcLayer, toMessagePortLike } from '../../src/renderer/ipc/desktop-ipc.ts';
import { WorkspaceIpcLive } from '../../src/renderer/ipc/workspace-ipc.ts';
import { makeWorkspaceClient, type FakeWorkspaceClient } from './workspace-client-fixture.ts';

export type { FakeWorkspaceClient };

/** A callback watch as a stream, closed (ignoring a close failure) when the stream ends. */
const watched = <A>(
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
  chooseCheckout: unused('The picker') as never,
  imports: unused('Imports') as never,
  release: async () => {},
  copyText: unused('The clipboard') as never,
  reveal: unused('Finder') as never,
};
export const noChat: ChatIpcOptions['backends'] = {
  getTargets: () => [],
  getContext: unused('Chat') as never,
  chooseFolder: unused('The folder picker') as never,
  recentFolders: async () => [],
  createWorktree: unused('Worktrees') as never,
  turnIntoProject: unused('Projects') as never,
  getSession: () => undefined,
};

/** A session's image as the protocol handler reads it, on `runtime`, as main binds it. */
export const toImageReader = (
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  found: SessionImage | undefined,
): TranscriptImageReader | undefined =>
  found && {
    image: found.image,
    read: (signal) => runApplicationEffect(runtime, found.read, { signal }),
  };
/** Polls `check` until it holds, failing if it never does. */
export async function waitFor(check: () => unknown) {
  for (let attempt = 0; attempt < 1000; attempt++) {
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
    chat?: Partial<ChatIpcOptions>;
    lifecycle?: DocumentHandlersOptions['lifecycle'];
    intercept?: DocumentHandlersOptions['intercept'];
  } = {},
) {
  const cleanupFailures: unknown[] = [];
  const reportCleanup = (error: unknown) => void cleanupFailures.push(error);
  const main = ManagedRuntime.make(Layer.empty);
  const actions = await main.runPromise(PubSub.unbounded<WindowAction>());
  const approvals = options.editor?.approvals ?? new EditorApprovals();
  const scope = Scope.makeUnsafe();
  const server = await main.runPromise(
    Scope.provide(
      makeIpcServer(
        makeDocumentHandlers({
          editor: {
            native: unusedNative,
            localHostId: async () => 'local-host',
            reportCleanup,
            ...options.editor,
            workspace: toWorkspaceService(options.editor?.client ?? unusedEditorClient),
            approvals,
          },
          chat: { backends: noChat, isQuitting: () => false, reportCleanup, ...options.chat },
          actions,
          lifecycle:
            options.lifecycle ?? (() => ({ markReady: () => {}, answerQuit: async () => {} })),
          ...(options.intercept ? { intercept: options.intercept } : {}),
        }),
      ),
      scope,
    ),
  );
  /** Main's ends of the ports it took. */
  const mainPorts = new Set<MessagePort>();
  /** A port pair whose main end the server takes, or undefined when it refuses one. */
  const openPort = (): MessagePort | undefined => {
    const { port1, port2 } = new MessageChannel();
    if (server.connect(toMainPortLike(port1))) {
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
          Effect.suspend(() => {
            const port = openPort();
            return port
              ? Effect.succeed<MessagePortLike>(toMessagePortLike(port))
              : Effect.fail('refused');
          }),
        ),
      ),
    );
  let renderer = makeRenderer();
  const connectRaw = (): RawConnection | undefined => {
    const port = openPort();
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
    raw ??= connectRaw();
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
      await main.runPromise(server.releaseDocument);
      await old.dispose();
    },
    async dispose() {
      raw?.close();
      await renderer.dispose();
      await main.runPromise(server.dispose);
      await main.dispose();
    },
  };
}
export type IpcFixture = Awaited<ReturnType<typeof makeIpcFixture>>;
