import { Cause, Effect, Predicate, Stream } from 'effect';
import * as Schema from 'effect/Schema';
import * as Socket from 'effect/socket/Socket';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import type { ChatCommand } from '@moonbase/contracts/chat';
import { isChatMutation } from '@moonbase/contracts/chat-validation';
import { IpcClosedError, IpcInputError, IpcReplyError } from '@moonbase/contracts/ipc-errors';
import { DesktopRpcs } from '../../ipc/desktop-rpcs.ts';
import { DesktopIpc } from './desktop-ipc.ts';

// The renderer's calls of main's procedures fail with main's error as it is, or with the
// renderer's own: a closed connection, or a request or reply its schemas refused (D14).

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

const closedError = (tag: string) => new IpcClosedError({ sent: isMutation(tag) });
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

/** The renderer's own refusal of a request it never sent, by the client that made it. */
export type Refusal = IpcInputError['problem'];
/** A procedure's failure as the application reads it, or none to keep the cause as it is. */
function toFailure<E>(
  tag: string,
  payload: unknown,
  refused: Refusal,
  cause: Cause.Cause<E | RpcClientError>,
): Effect.Effect<E | IpcClosedError | IpcInputError | IpcReplyError | undefined> {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === 'Some') {
    const error = failure.value;
    return Effect.succeed(isClientError(error) ? closedError(tag) : (error as E));
  }
  if (!Cause.hasDies(cause) || Cause.hasInterrupts(cause)) return Effect.succeed(undefined);
  const defect = Cause.squash(cause);
  // A port that closed as a request was written.
  if (Socket.isSocketError(defect) || isClientError(defect))
    return Effect.succeed(closedError(tag));
  const invalid = new IpcInputError({ problem: refused });
  const incompatible = new IpcReplyError();
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
const applicationFailures = <A, E, R>(
  effect: Effect.Effect<A, E | RpcClientError, R>,
  tag: string,
  payload: unknown,
  refused: Refusal,
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.flatMap(toFailure(tag, payload, refused, cause), (error) =>
        error ? Effect.fail(error) : Effect.failCause(cause as Cause.Cause<never>),
      ),
    ),
  );
const applicationStreamFailures = <A, E, R>(
  stream: Stream.Stream<A, E | RpcClientError, R>,
  tag: string,
  payload: unknown,
  refused: Refusal,
) =>
  stream.pipe(
    Stream.catchCause((cause) =>
      Stream.unwrap(
        Effect.map(toFailure(tag, payload, refused, cause), (error) =>
          error ? Stream.fail(error) : Stream.failCause(cause as Cause.Cause<never>),
        ),
      ),
    ),
  );

export type Tag = keyof Client & string;
export type Payload<T extends Tag> = Parameters<Client[T]>[0];
export type Reply<T extends Tag> = ReturnType<Client[T]>;
/** What procedure `T` fails with, as main declares it. */
export type Failure<T extends Tag> =
  Reply<T> extends Effect.Effect<unknown, infer E, unknown>
    ? E
    : Reply<T> extends Stream.Stream<unknown, infer E, unknown>
      ? E
      : never;
type Procedure = (payload: unknown) => never;
const procedure = <T extends Tag>(client: Client, tag: T, payload: Payload<T>): Reply<T> =>
  (client as unknown as Record<string, Procedure>)[tag]!(payload);
/** A procedure's watch, failing as the application reads failures. */
export const watchStream = <T extends Tag>(tag: T, payload: Payload<T>, refused: Refusal) =>
  applicationStreamFailures(
    Stream.unwrap(
      Effect.map(
        DesktopIpc,
        (client) =>
          procedure(client, tag, payload) as Stream.Stream<
            Stream.Success<Reply<T>>,
            Failure<T> | RpcClientError
          >,
      ),
    ),
    tag,
    payload,
    refused,
  );

/** A procedure's call, failing as the application reads failures. */
export const callEffect = <T extends Tag>(tag: T, payload: Payload<T>, refused: Refusal) =>
  applicationFailures(
    Effect.flatMap(
      DesktopIpc,
      (client) =>
        procedure(client, tag, payload) as Effect.Effect<
          Effect.Success<Reply<T>>,
          Failure<T> | RpcClientError
        >,
    ),
    tag,
    payload,
    refused,
  );
