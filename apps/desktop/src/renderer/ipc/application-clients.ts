import { Cause, Deferred, Duration, Effect, Exit, Schedule, Stream } from 'effect';
import { CancelledError } from '@moonbase/contracts/errors';
import { IpcFailedError } from '@moonbase/contracts/ipc-errors';
import { isUnavailable } from '@moonbase/contracts/error-groups';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import { connectionInputSchemas } from '@moonbase/contracts/connection-schema';
import { providerInputSchemas } from '@moonbase/contracts/providers-schema';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { ChatPort, ConnectionPort, ProviderSetupPort } from '@moonbase/application/chat';
import type { DesktopBridge } from '../../ipc/desktop-bridge.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import type { WindowAction } from '../../ipc/window-rpcs.ts';
import type { WindowFailure } from '../../ipc/ipc-errors.ts';
import type { TranscriptNative } from '../chat/transcript/transcript-actions.ts';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Refusal, type Tag } from './ipc-failures.ts';

// The chat runs on Effect ports over main's procedures. The shell and a transcript's native
// actions are Promise code for React views, bound to the renderer's root runtime once, here.

/**
 * The renderer root's runner, which provides `DesktopIpc`: an Effect's exit as a Promise, the
 * Effect interrupted once `signal` aborts. The root binds it to its one runtime.
 */
export type DesktopIpcRunner = <A, E>(
  effect: Effect.Effect<A, E, DesktopIpc>,
  options?: { signal?: AbortSignal },
) => Promise<Exit.Exit<A, E>>;
/**
 * Runs `effect` for a Promise caller: its value, or a rejection with its failure as the
 * application reads failures; once interrupted, a `CancelledError` for `operation`.
 */
async function runForCaller<A, E>(
  run: DesktopIpcRunner,
  effect: Effect.Effect<A, E, DesktopIpc>,
  operation: string,
  options?: { signal?: AbortSignal },
): Promise<A> {
  const exit = await run(effect, options);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === 'Some') throw failure.value;
  throw Cause.hasInterruptsOnly(exit.cause)
    ? new CancelledError({ operation })
    : new IpcFailedError();
}
/** Binds procedures to `run`: one call each, failing as the application reads failures. */
function makeCaller(run: DesktopIpcRunner, refused: Refusal) {
  return {
    call: <T extends Tag>(tag: T, payload: Payload<T>, options?: { signal?: AbortSignal }) =>
      runForCaller(run, callEffect(tag, payload, refused), tag, options),
  };
}

const refusedChat: Refusal = 'chat-request';
/**
 * One chat target's chat, provider setup and (for the remote host) connection ports: each command
 * and watch is main's procedure over this document's IPC port, failing with the error main sends
 * or the renderer's own.
 */
export const makeChatTargetPorts = (backendId: ChatTargetId) =>
  Effect.map(Effect.context<DesktopIpc>(), (ipc) => {
    const call = (tag: string, payload: unknown) =>
      callEffect(tag as Tag, payload as Payload<Tag>, refusedChat).pipe(Effect.provideContext(ipc));
    const watch = (tag: string, payload: unknown) =>
      watchStream(tag as Tag, payload as Payload<Tag>, refusedChat).pipe(
        Stream.provideContext(ipc),
      );
    const commands = (operations: readonly string[], payload: (input: unknown) => unknown) =>
      Object.fromEntries(
        operations.map((operation) => [
          operation,
          (input: unknown) => call(operation, payload(input)),
        ]),
      );
    const chat = {
      ...commands(Object.keys(chatInputSchemas), (input) => ({ backendId, input })),
      watch: ({ target }: { target: unknown }) => watch('watchChat', { backendId, target }),
      watchChatList: ({ session }: { session: unknown }) =>
        watch('watchChatList', { backendId, session }),
    } as unknown as ChatPort;
    const providers = {
      ...commands(Object.keys(providerInputSchemas), (input) => ({ backendId, input })),
      watch: () => watch('watchProviders', { backendId }),
    } as unknown as ProviderSetupPort;
    const connection = {
      ...commands(Object.keys(connectionInputSchemas), (input) => ({ input })),
      watch: () => watch('watchConnection', undefined),
    } as unknown as ConnectionPort;
    return { chat, providers, connection };
  });

/** One chat target's transcript native actions. */
export function makeChatTargetClients(run: DesktopIpcRunner, backendId: ChatTargetId) {
  const { call } = makeCaller(run, refusedChat);
  const transcript: TranscriptNative = {
    copy: (copy, signal) => call('copyTranscript', { backendId, copy }, { signal }),
    openLink: (url, signal) => call('openTranscriptLink', { backendId, url }, { signal }),
    imageUrl: (image, signal) => call('getTranscriptImageUrl', { backendId, image }, { signal }),
  };
  return { transcript };
}

/** Each re-watch of the window's actions waits longer, up to a few seconds. */
const windowActionsRetry = Schedule.exponential('50 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
);

type QuitAnswer = { consent: boolean; cleanupError?: WindowFailure };

/** The shell's native actions and chat folders, and the window's own procedures. */
export function makeShellClients(run: DesktopIpcRunner, bridge: DesktopBridge) {
  const refused: Refusal = 'desktop-request';
  const { call } = makeCaller(run, refused);
  /** Each Quit or disposal request this document took, with its answer once it has one. */
  const quitAnswers = new Map<string, QuitAnswer | undefined>();
  /** The cleanup failures this document heard of: main tells each watch of them all. */
  const heardFailures = new Set<string>();
  /** Sends an answer, again while main can't be reached: the document may already be gone. */
  const sendQuitAnswer = (id: string, answer: QuitAnswer) =>
    runForCaller(
      run,
      callEffect('answerQuit', { id, ...answer }, refused).pipe(
        Effect.retry({ schedule: windowActionsRetry, times: 8, while: isUnavailable }),
      ),
      'answerQuit',
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
    watchWindowActions: (receive: (action: WindowAction) => void) => {
      let closing = false;
      const take = (action: WindowAction) => {
        if (closing) return;
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
      };
      const stop = Deferred.makeUnsafe<void>();
      const watching = run(
        watchStream('watchWindowActions', undefined, refused).pipe(
          Stream.retry(windowActionsRetry),
          Stream.runForEach((action) => Effect.sync(() => take(action))),
          Effect.ignore,
          Effect.raceFirst(Deferred.await(stop)),
        ),
      );
      // Closing stops delivery at once, then ends the watch.
      return () => {
        closing = true;
        Deferred.doneUnsafe(stop, Effect.void);
        return watching.then(() => undefined);
      };
    },
    /** Answers a `quit` or `dispose` request; main ignores an answer to any other. */
    answerQuit: (id: string, consent: boolean, cleanupError?: WindowFailure) => {
      const answer = { consent, ...(cleanupError ? { cleanupError } : {}) };
      quitAnswers.set(id, answer);
      return sendQuitAnswer(id, answer);
    },
  };
}
