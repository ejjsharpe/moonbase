import { Cause, Duration, Effect, Predicate, Schedule, Stream, type ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';
import * as Socket from 'effect/socket/Socket';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import {
  observeApplicationStream,
  runApplicationEffect,
} from '@moonbase/application/runtime/effect-client';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient, ChatCommand } from '@moonbase/contracts/chat';
import { isChatMutation } from '@moonbase/contracts/chat-validation';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import type { CheckoutTarget, EditorClient } from '@moonbase/contracts/workspace';
import type { DesktopBridge } from '../../ipc/desktop-bridge.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import { DesktopRpcs } from '../../ipc/desktop-rpcs.ts';
import type { WindowAction } from '../../ipc/window-rpcs.ts';
import { toLegacyApplicationError, type DesktopIpcError } from '../../ipc/ipc-errors.ts';
import type { TranscriptNative } from '../chat/transcript/transcript-actions.ts';
import { DesktopIpc } from './desktop-ipc.ts';

// The application and shell still take Promise clients (D16 moves them to services and atoms).
// These bind `DesktopIpc` to the renderer's root runtime once, here, and give each failure the
// `ApplicationError` the application has always read.

export type DesktopRuntime = ManagedRuntime.ManagedRuntime<DesktopIpc, never>;
type Client = DesktopIpc['Service'];
/** Commands that change state: one whose connection closes may have run, so it is `Uncertain`. */
const mutations = new Set<string>([
  'saveFile',
  'mutate',
  'createWorktree',
  'initializeRepository',
  'acknowledgeOperation',
  'persistRecovery',
  'startProviderLogin',
  'answerProviderPrompt',
  'cancelProviderLogin',
  'logoutProvider',
  'connect',
  'disconnect',
  'createChatWorktree',
  'turnChatIntoProject',
]);
const isMutation = (tag: string) => mutations.has(tag) || isChatMutation(tag as ChatCommand);

const closedError = (tag: string) =>
  isMutation(tag)
    ? new ApplicationError({
        code: 'Uncertain',
        message: 'The connection to Moonbase closed after this was sent. Check its outcome.',
      })
    : new ApplicationError({ code: 'Unavailable', message: 'The connection to Moonbase closed.' });
const isClientError = (value: unknown): value is RpcClientError =>
  Predicate.isTagged(value, 'RpcClientError');
/** Whether the renderer's schemas encode `payload` for `tag`: whether it was ever sent. */
const encodesPayload = (tag: string, payload: unknown) =>
  Schema.encodeUnknownEffect(
    Schema.toCodecJson(DesktopRpcs.requests.get(tag)!.payloadSchema as Schema.Top),
  )(payload).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  ) as Effect.Effect<boolean>;

/** A procedure's failure as the application reads it, or none to keep the cause as it is. */
function toApplicationError(
  tag: string,
  payload: unknown,
  refused: string,
  cause: Cause.Cause<DesktopIpcError | RpcClientError>,
): Effect.Effect<ApplicationError | undefined> {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === 'Some') {
    const error = failure.value;
    return Effect.succeed(
      isClientError(error) ? closedError(tag) : toLegacyApplicationError(error),
    );
  }
  if (!Cause.hasDies(cause) || Cause.hasInterrupts(cause)) return Effect.succeed(undefined);
  const defect = Cause.squash(cause);
  // A port that closed as a request was written.
  if (Socket.isSocketError(defect) || isClientError(defect))
    return Effect.succeed(closedError(tag));
  const invalid = new ApplicationError({ code: 'InvalidInput', message: refused });
  const incompatible = new ApplicationError({
    code: 'Incompatible',
    message: 'Invalid reply from Moonbase.',
  });
  // The renderer's schemas refused its own request, which was never sent, or main's reply.
  if (Schema.isSchemaError(defect))
    return Effect.map(encodesPayload(tag, payload), (sent) => (sent ? incompatible : invalid));
  // Main reports a request its schemas refused, or a reply they could not encode, as text: the
  // RPC server's own, the one detail of its defect that crosses.
  return Effect.succeed(
    typeof defect === 'string' && defect.startsWith('Failed to encode response')
      ? incompatible
      : invalid,
  );
}
const applicationFailures = <A, R>(
  effect: Effect.Effect<A, DesktopIpcError | RpcClientError, R>,
  tag: string,
  payload: unknown,
  refused: string,
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.flatMap(toApplicationError(tag, payload, refused, cause), (error) =>
        error ? Effect.fail(error) : Effect.failCause(cause as Cause.Cause<never>),
      ),
    ),
  );
const applicationStreamFailures = <A, R>(
  stream: Stream.Stream<A, DesktopIpcError | RpcClientError, R>,
  tag: string,
  payload: unknown,
  refused: string,
) =>
  stream.pipe(
    Stream.catchCause((cause) =>
      Stream.unwrap(
        Effect.map(toApplicationError(tag, payload, refused, cause), (error) =>
          error ? Stream.fail(error) : Stream.failCause(cause as Cause.Cause<never>),
        ),
      ),
    ),
  );

type Tag = keyof Client & string;
type Payload<T extends Tag> = Parameters<Client[T]>[0];
type Reply<T extends Tag> = ReturnType<Client[T]>;
type Procedure = (payload: unknown) => never;
const procedure = <T extends Tag>(client: Client, tag: T, payload: Payload<T>): Reply<T> =>
  (client as unknown as Record<string, Procedure>)[tag]!(payload);
/** A procedure's watch, failing as the application reads failures. */
const watchStream = <T extends Tag>(tag: T, payload: Payload<T>, refused: string) =>
  applicationStreamFailures(
    Stream.unwrap(
      Effect.map(
        DesktopIpc,
        (client) =>
          procedure(client, tag, payload) as Stream.Stream<
            Stream.Success<Reply<T>>,
            DesktopIpcError | RpcClientError
          >,
      ),
    ),
    tag,
    payload,
    refused,
  );

/** A procedure's call, failing as the application reads failures. */
const callEffect = <T extends Tag>(tag: T, payload: Payload<T>, refused: string) =>
  applicationFailures(
    Effect.flatMap(
      DesktopIpc,
      (client) =>
        procedure(client, tag, payload) as Effect.Effect<
          Effect.Success<Reply<T>>,
          DesktopIpcError | RpcClientError
        >,
    ),
    tag,
    payload,
    refused,
  );

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

/** The editor's workspace commands and watch. */
export function makeEditorClient(runtime: DesktopRuntime): EditorClient {
  const { call, watch } = makeCaller(runtime, 'Invalid workspace input.');
  return {
    command: (operation, input, options) => call(operation, input as never, options) as never,
    watch: (input, receive, onError) => watch('watchWorkspace', input, receive, onError),
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
