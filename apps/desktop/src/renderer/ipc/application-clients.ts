import { Cause, Effect, Stream, type ManagedRuntime } from 'effect';
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

/** A procedure's failure as the application reads it. */
function toApplicationError(tag: string, refused: string) {
  return (cause: Cause.Cause<DesktopIpcError | RpcClientError>) => {
    const failure = Cause.findErrorOption(cause);
    if (failure._tag === 'Some') {
      const error = failure.value;
      if (error._tag !== 'RpcClientError') return toLegacyApplicationError(error);
      return isMutation(tag)
        ? new ApplicationError({
            code: 'Uncertain',
            message: 'The connection to Moonbase closed after this was sent. Check its outcome.',
          })
        : new ApplicationError({
            code: 'Unavailable',
            message: 'The connection to Moonbase closed.',
          });
    }
    // Main answers a request its schemas refused, or a reply they could not encode, as a defect.
    if (Cause.hasDies(cause) && !Cause.hasInterrupts(cause)) {
      const defect = String(Cause.squash(cause));
      return defect.startsWith('Failed to encode response')
        ? new ApplicationError({ code: 'Incompatible', message: 'Invalid reply from Moonbase.' })
        : new ApplicationError({ code: 'InvalidInput', message: refused });
    }
    return undefined;
  };
}
const applicationFailures = <A, R>(
  effect: Effect.Effect<A, DesktopIpcError | RpcClientError, R>,
  tag: string,
  refused: string,
) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const error = toApplicationError(tag, refused)(cause);
      return error ? Effect.fail(error) : Effect.failCause(cause as Cause.Cause<never>);
    }),
  );
const applicationStreamFailures = <A, R>(
  stream: Stream.Stream<A, DesktopIpcError | RpcClientError, R>,
  tag: string,
  refused: string,
) =>
  stream.pipe(
    Stream.catchCause((cause) => {
      const error = toApplicationError(tag, refused)(cause);
      return error ? Stream.fail(error) : Stream.failCause(cause as Cause.Cause<never>);
    }),
  );

/** Binds procedures to `runtime`: one call each, failing as the application reads failures. */
function makeCaller(runtime: DesktopRuntime, refused: string) {
  return {
    call: <A>(
      tag: string,
      use: (client: Client) => Effect.Effect<A, DesktopIpcError | RpcClientError>,
      options?: { signal?: AbortSignal },
    ) =>
      runApplicationEffect(
        runtime,
        applicationFailures(Effect.flatMap(DesktopIpc, use), tag, refused),
        options,
      ),
    watch: <A>(
      tag: string,
      use: (client: Client) => Stream.Stream<A, DesktopIpcError | RpcClientError>,
      receive: (value: A) => void,
      onError: (error: ApplicationError) => void,
    ) =>
      observeApplicationStream(
        runtime,
        applicationStreamFailures(Stream.unwrap(Effect.map(DesktopIpc, use)), tag, refused),
        receive,
        onError,
      ),
  };
}
type Procedure = (payload: unknown) => Effect.Effect<never, DesktopIpcError | RpcClientError>;
const procedure = (client: Client, tag: string) =>
  (client as unknown as Record<string, Procedure>)[tag]!;

/** The editor's workspace commands and watch. */
export function makeEditorClient(runtime: DesktopRuntime): EditorClient {
  const { call, watch } = makeCaller(runtime, 'Invalid workspace input.');
  return {
    command: (operation, input, options) =>
      call(operation, (client) => procedure(client, operation)(input), options),
    watch: (input, receive, onError) =>
      watch('watchWorkspace', (client) => client.watchWorkspace(input), receive, onError),
  };
}

/** One chat target's chat, provider setup and (for the remote host) connection. */
export function makeChatTargetClients(runtime: DesktopRuntime, backendId: ChatTargetId) {
  const { call, watch } = makeCaller(runtime, 'Invalid chat request.');
  const chat: ChatClient = {
    command: (operation, input, options) =>
      call(operation, (client) => procedure(client, operation)({ backendId, input }), options),
    watch: ({ target }, receive, onError) =>
      watch('watchChat', (client) => client.watchChat({ backendId, target }), receive, onError),
    watchChatList: ({ session }, receive, onError) =>
      watch(
        'watchChatList',
        (client) => client.watchChatList({ backendId, session }),
        receive,
        onError,
      ),
  };
  const providers: ProviderSetupClient = {
    command: (operation, input, options) =>
      call(operation, (client) => procedure(client, operation)({ backendId, input }), options),
    watch: (receive, onError) =>
      watch('watchProviders', (client) => client.watchProviders({ backendId }), receive, onError),
  };
  const connection: ConnectionClient = {
    command: (operation, input, options) =>
      call(operation, (client) => procedure(client, operation)({ input }), options),
    watch: (receive, onError) =>
      watch('watchConnection', (client) => client.watchConnection(), receive, onError),
  };
  const transcript: TranscriptNative = {
    copy: (copy, signal) =>
      call('copyTranscript', (client) => client.copyTranscript({ backendId, copy }), { signal }),
    openLink: (url, signal) =>
      call('openTranscriptLink', (client) => client.openTranscriptLink({ backendId, url }), {
        signal,
      }),
    imageUrl: (image, signal) =>
      call(
        'getTranscriptImageUrl',
        (client) => client.getTranscriptImageUrl({ backendId, image }),
        {
          signal,
        },
      ),
  };
  return {
    chat,
    providers,
    connection,
    transcript,
    context: () => call('getChatContext', (client) => client.getChatContext({ backendId })),
  };
}

/** The shell's native actions and chat folders, and the window's own procedures. */
export function makeShellClients(runtime: DesktopRuntime, bridge: DesktopBridge) {
  const { call, watch } = makeCaller(runtime, 'Invalid desktop request.');
  return {
    chatTargets: () => call('getChatTargets', (client) => client.getChatTargets()),
    chooseChatFolder: () => call('chooseChatFolder', (client) => client.chooseChatFolder()),
    listChatFolders: (backendId: ChatTargetId) =>
      call('listChatFolders', (client) => client.listChatFolders({ backendId })),
    createChatWorktree: (root: string, branch: string, requestId: string) =>
      call('createChatWorktree', (client) =>
        client.createChatWorktree({ root, branch, requestId }),
      ),
    turnChatIntoProject: (conversationId: string) =>
      call('turnChatIntoProject', (client) => client.turnChatIntoProject({ conversationId })),
    chooseCheckout: () => call('chooseCheckout', (client) => client.chooseCheckout()),
    pasteImports: (checkout: CheckoutTarget) =>
      call('pasteImports', (client) => client.pasteImports({ checkout })),
    /** Imports dropped files; a drop with no file main can read imports nothing. */
    dropImports: async (checkout: CheckoutTarget, files: File[]) => {
      const paths = files.map((file) => bridge.pathForFile(file)).filter(Boolean);
      return call('dropImports', (client) => client.dropImports({ checkout, paths }));
    },
    copyPaths: (checkout: CheckoutTarget, paths: string[], relative: boolean) =>
      call('copyPaths', (client) => client.copyPaths({ checkout, paths, relative })),
    revealPath: (checkout: CheckoutTarget, path: string) =>
      call('revealPath', (client) => client.revealPath({ checkout, path })),
    watchWindowActions: (
      receive: Parameters<
        typeof watch<Stream.Success<ReturnType<Client['watchWindowActions']>>>
      >[2],
      onError: (error: ApplicationError) => void,
    ) => watch('watchWindowActions', (client) => client.watchWindowActions(), receive, onError),
    answerQuit: (id: string, consent: boolean, cleanupError?: ApplicationError) =>
      call('answerQuit', (client) =>
        client.answerQuit({ id, consent, ...(cleanupError ? { cleanupError } : {}) }),
      ),
  };
}
