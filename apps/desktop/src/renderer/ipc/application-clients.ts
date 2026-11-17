import { Duration, Effect, Schedule, Stream, type ManagedRuntime } from 'effect';
import {
  observeApplicationStream,
  runApplicationEffect,
} from '@moonbase/application/chat/promises';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { DesktopBridge } from '../../ipc/desktop-bridge.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import type { WindowAction } from '../../ipc/window-rpcs.ts';
import type { TranscriptNative } from '../chat/transcript/transcript-actions.ts';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Reply, type Tag } from './ipc-failures.ts';

// The chat and shell still take Promise clients (CL-22 moves chat to services and atoms). These
// bind `DesktopIpc` to the renderer's root runtime once, here.

/** The root runtime, which provides `DesktopIpc`, as these clients run on it. */
export type DesktopRuntime = Pick<
  ManagedRuntime.ManagedRuntime<DesktopIpc, never>,
  'runPromiseExit'
>;
/** Binds procedures to `runtime`: one call each, failing as the application reads failures. */
function makeCaller(runtime: DesktopRuntime, refused: string) {
  return {
    call: <T extends Tag>(tag: T, payload: Payload<T>, options?: { signal?: AbortSignal }) =>
      runApplicationEffect(runtime, callEffect(tag, payload, refused), options),
    watch: <T extends Tag>(
      tag: T,
      payload: Payload<T>,
      receive: (value: Stream.Success<Reply<T>>) => void,
      onError: (error: ApplicationError) => void,
    ) => observeApplicationStream(runtime, watchStream(tag, payload, refused), receive, onError),
  };
}

/** One chat target's chat, provider setup and (for the remote host) connection. */
export function makeChatTargetClients(runtime: DesktopRuntime, backendId: ChatTargetId) {
  const { call, watch } = makeCaller(runtime, 'Invalid chat request.');
  const chat: ChatClient = {
    command: (operation, input, options) =>
      call(operation, { backendId, input } as never, options) as never,
    watch: ({ target }, receive, onError) =>
      watch('watchChat', { backendId, target }, receive, onError),
    watchChatList: ({ session }, receive, onError) =>
      watch('watchChatList', { backendId, session }, receive, onError),
  };
  const providers: ProviderSetupClient = {
    command: (operation, input, options) =>
      call(operation, { backendId, input } as never, options) as never,
    watch: (receive, onError) => watch('watchProviders', { backendId }, receive, onError),
  };
  const connection: ConnectionClient = {
    command: (operation, input, options) => call(operation, { input } as never, options) as never,
    watch: (receive, onError) => watch('watchConnection', undefined, receive, onError),
  };
  const transcript: TranscriptNative = {
    copy: (copy, signal) => call('copyTranscript', { backendId, copy }, { signal }),
    openLink: (url, signal) => call('openTranscriptLink', { backendId, url }, { signal }),
    imageUrl: (image, signal) => call('getTranscriptImageUrl', { backendId, image }, { signal }),
  };
  return {
    chat,
    providers,
    connection,
    transcript,
    context: () => call('getChatContext', { backendId }),
  };
}

/** Each re-watch of the window's actions waits longer, up to a few seconds. */
const windowActionsRetry = Schedule.exponential('50 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
);

type QuitAnswer = { consent: boolean; cleanupError?: ApplicationError };

/** The shell's native actions and chat folders, and the window's own procedures. */
export function makeShellClients(runtime: DesktopRuntime, bridge: DesktopBridge) {
  const refused = 'Invalid desktop request.';
  const { call } = makeCaller(runtime, refused);
  /** Each Quit or disposal request this document took, with its answer once it has one. */
  const quitAnswers = new Map<string, QuitAnswer | undefined>();
  /** The cleanup failures this document heard of: main tells each watch of them all. */
  const heardFailures = new Set<string>();
  /** Sends an answer, again while main can't be reached: the document may already be gone. */
  const sendQuitAnswer = (id: string, answer: QuitAnswer) =>
    runApplicationEffect(
      runtime,
      callEffect('answerQuit', { id, ...answer }, refused).pipe(
        Effect.retry({
          schedule: windowActionsRetry,
          times: 8,
          while: (error) => error.code === 'Unavailable',
        }),
      ),
    );
  return {
    chatTargets: () => call('getChatTargets', undefined),
    chooseChatFolder: () => call('chooseChatFolder', undefined),
    listChatFolders: (backendId: ChatTargetId) => call('listChatFolders', { backendId }),
    createChatWorktree: (root: string, branch: string, requestId: string) =>
      call('createChatWorktree', { root, branch, requestId }),
    turnChatIntoProject: (conversationId: string) =>
      call('turnChatIntoProject', { conversationId }),
    chooseCheckout: () => call('chooseCheckout', undefined),
    pasteImports: (checkout: CheckoutTarget) => call('pasteImports', { checkout }),
    /** Imports dropped files; a drop with no file main can read imports nothing. */
    dropImports: async (checkout: CheckoutTarget, files: File[]) => {
      const paths = files.map((file) => bridge.pathForFile(file)).filter(Boolean);
      return call('dropImports', { checkout, paths });
    },
    copyPaths: (checkout: CheckoutTarget, paths: string[], relative: boolean) =>
      call('copyPaths', { checkout, paths, relative }),
    revealPath: (checkout: CheckoutTarget, path: string) => call('revealPath', { checkout, path }),
    /**
     * Main's requests of this document, for as long as it lives, each taken once. Watching says
     * the document is ready, so a watch its connection ends watches again, and main asks again
     * what is pending: a request already answered gets its answer again, which may have been lost.
     */
    watchWindowActions: (receive: (action: WindowAction) => void) =>
      observeApplicationStream(
        runtime,
        watchStream('watchWindowActions', undefined, refused).pipe(
          Stream.retry(windowActionsRetry),
        ),
        (action) => {
          if (action.action === 'cleanup-error') {
            if (heardFailures.has(action.id)) return;
            heardFailures.add(action.id);
            return receive(action);
          }
          if (!quitAnswers.has(action.id)) {
            quitAnswers.set(action.id, undefined);
            return receive(action);
          }
          const answer = quitAnswers.get(action.id);
          if (answer) void sendQuitAnswer(action.id, answer).catch(() => {});
        },
        () => {},
      ),
    /** Answers a `quit` or `dispose` request; main ignores an answer to any other. */
    answerQuit: (id: string, consent: boolean, cleanupError?: ApplicationError) => {
      const answer = { consent, ...(cleanupError ? { cleanupError } : {}) };
      quitAnswers.set(id, answer);
      return sendQuitAnswer(id, answer);
    },
  };
}
