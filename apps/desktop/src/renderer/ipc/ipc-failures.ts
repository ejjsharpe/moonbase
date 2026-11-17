import { Cause, Effect, Predicate, Stream } from 'effect';
import * as Schema from 'effect/Schema';
import * as Socket from 'effect/socket/Socket';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatCommand } from '@moonbase/contracts/chat';
import { isChatMutation } from '@moonbase/contracts/chat-validation';
import { DesktopRpcs } from '../../ipc/desktop-rpcs.ts';
import { toLegacyApplicationError, type DesktopIpcError } from '../../ipc/ipc-errors.ts';
import { DesktopIpc } from './desktop-ipc.ts';

// The renderer's calls of main's procedures fail with the `ApplicationError` the application has
// always read (D14 moves the readers to tags): a closed connection, a refused request or reply,
// or main's own error.

type Client = DesktopIpc['Service'];

/**
 * Commands that change state: one whose connection closes may have run, so it is `Uncertain`.
 * Recovery edits are not among them: each sets a state, so sending one again is safe.
 */
const mutations = new Set<string>([
  'saveFile',
  'mutate',
  'createWorktree',
  'initializeRepository',
  'acknowledgeOperation',
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

export type Tag = keyof Client & string;
export type Payload<T extends Tag> = Parameters<Client[T]>[0];
export type Reply<T extends Tag> = ReturnType<Client[T]>;
type Procedure = (payload: unknown) => never;
const procedure = <T extends Tag>(client: Client, tag: T, payload: Payload<T>): Reply<T> =>
  (client as unknown as Record<string, Procedure>)[tag]!(payload);
/** A procedure's watch, failing as the application reads failures. */
export const watchStream = <T extends Tag>(tag: T, payload: Payload<T>, refused: string) =>
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
export const callEffect = <T extends Tag>(tag: T, payload: Payload<T>, refused: string) =>
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
