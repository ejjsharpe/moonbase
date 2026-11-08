import { Effect, Layer, Stream, Schedule, Exit, Cause, Queue, Clock } from 'effect';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  chatStreamFeature,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
  type ChatTarget,
  type ChatSnapshot,
} from '@moonbase/contracts/chat';
import { chatReplyErrorCodes, decodeChatStreamFrame } from '@moonbase/contracts/chat-schema';
import { releaseResource } from '@moonbase/effect';
import {
  ChatService,
  ConnectionService,
  type ChatServiceShape,
  type ConnectionServiceShape,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { validateHostHealth } from '@moonbase/ssh/host-health';
import * as P from './protocol.ts';
import * as V from './validation.ts';

const renewAfterNanos = BigInt(P.streamLimits.renewMs) * 1_000_000n;

/** Client graph imports no engine, SQLite, provider or local workspace implementation. */
export const RemoteChatLive: Layer.Layer<ChatService, never, ConnectionService> = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    const call = <K extends ChatCommand>(
      operation: K,
      unknown: ChatInput<K>,
    ): Effect.Effect<ChatOutput<K>, ApplicationError> =>
      Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => V.input(operation, unknown),
          catch: ApplicationError.fromUnknown,
        });
        if (operation === 'createChat' && (input as ChatInput<'createChat'>).settings !== undefined)
          return yield* Effect.fail(
            new ApplicationError({
              code: 'InvalidInput',
              message: 'Remote chats retain the host’s fixed working folder and model.',
            }),
          );
        const mutation = V.isMutation(operation);
        let dispatched = false;
        const shape = input as {
          host?: { hostId: string; storeId: string };
          session?: { host: { hostId: string; storeId: string } };
          target?: ChatTarget;
          source?: { target: ChatTarget };
          stop?: { target: ChatTarget };
        };
        const host =
          shape.host ??
          shape.session?.host ??
          shape.target?.host ??
          shape.source?.target.host ??
          shape.stop!.target.host;
        const endpoint = yield* connections.endpoint({ host });
        const changed = () =>
          new ApplicationError({
            code: mutation && dispatched ? 'Uncertain' : 'Unavailable',
            message:
              mutation && dispatched
                ? 'Connection changed after a chat mutation may have dispatched. Preserve its original request and reconcile through its authority.'
                : 'Connection generation changed; query through the selected authority again.',
          });
        const assertGeneration = makeGenerationCheck(
          connections,
          host,
          endpoint,
          changed,
          (error) => (mutation && dispatched ? changed() : error),
        );
        const prepared = yield* Effect.try({
          try: () => ({ origin: P.origin(endpoint), nonce: P.nonce() }),
          catch: ApplicationError.fromUnknown,
        });
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), P.requestDeadlineMs),
          request = makeChatRequest(prepared.origin, controller.signal);
        const attempt = yield* Effect.exit(
          Effect.ensuring(
            Effect.gen(function* () {
              const challenge = yield* authenticateChallenge(
                request,
                endpoint.token,
                prepared.nonce,
                host,
              );
              yield* assertGeneration;
              const body = JSON.stringify({ operation, input });
              if (Buffer.byteLength(body) > P.maximumChatRequestBytes)
                return yield* Effect.fail(
                  new ApplicationError({
                    code: 'InvalidInput',
                    message: 'Chat input exceeds its transport limit.',
                  }),
                );
              const lost = () =>
                new ApplicationError({
                  code: mutation ? 'Uncertain' : 'Unavailable',
                  message: mutation
                    ? 'Chat reply was lost. Query the original request; do not invent another Send.'
                    : 'Chat reply was lost. Retry the read through the selected authority.',
                });
              const response = yield* Effect.suspend(() => {
                dispatched = true;
                return request(
                  '/v1/chat',
                  {
                    method: 'POST',
                    body,
                    headers: {
                      'content-type': 'application/json',
                      'X-Moonbase-Nonce': prepared.nonce,
                      'X-Moonbase-Challenge': challenge,
                      Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token, 'request', prepared.nonce, challenge, 'POST', '/v1/chat', P.hash(body))}`,
                    },
                  },
                  lost,
                );
              });
              const bytes = yield* P.responseBytes(
                response,
                P.maximumChatReplyBytes,
                mutation ? 'Uncertain' : 'Unavailable',
                mutation,
              );
              const result = yield* Effect.try({
                try: () => {
                  const invalid = (code: 'Unauthorized' | 'Incompatible', message: string): never =>
                    V.fail(
                      mutation ? 'Uncertain' : code,
                      mutation
                        ? 'Chat mutation outcome could not be authenticated. Preserve its original request and query before retrying.'
                        : message,
                    );
                  if (
                    response.headers.get('x-moonbase-nonce') !== prepared.nonce ||
                    response.headers.get('x-moonbase-challenge') !== challenge ||
                    !P.proof(
                      response.headers.get('x-moonbase-proof'),
                      P.mac(
                        endpoint.token,
                        'response',
                        prepared.nonce,
                        challenge,
                        response.status,
                        P.hash(bytes),
                      ),
                    )
                  )
                    invalid('Unauthorized', 'Chat host did not prove its response.');
                  let envelope: Record<string, unknown>;
                  try {
                    envelope = V.object(P.json(bytes));
                  } catch {
                    return invalid('Incompatible', 'Chat returned invalid response data.');
                  }
                  if (envelope.ok === false)
                    throw (
                      decodeErrorEnvelope(envelope.error, operation) ??
                      invalid('Incompatible', 'Chat returned an invalid error.')
                    );
                  if (envelope.ok !== true || response.status !== 200)
                    return invalid('Incompatible', 'Chat reply has an unexpected status or shape.');
                  try {
                    const output = V.output(operation, envelope.value, input);
                    if (operation === 'getChatHost' && output && 'mode' in output)
                      V.fail(
                        'Incompatible',
                        'An SSH host must supply its fixed working folder and model.',
                      );
                    return output;
                  } catch {
                    return invalid('Incompatible', 'Chat returned invalid response data.');
                  }
                },
                catch: (error) => (ApplicationError.is(error) ? error : lost()),
              });
              return result;
            }),
            Effect.sync(() => {
              clearTimeout(timer);
              controller.abort();
            }),
          ),
        );
        if (Exit.isFailure(attempt) && Cause.hasInterruptsOnly(attempt.cause))
          return yield* Effect.failCause(attempt.cause);
        const generation = yield* Effect.exit(assertGeneration);
        if (Exit.isFailure(generation))
          return yield* Effect.failCause(
            Exit.isFailure(attempt)
              ? Cause.combine(generation.cause, attempt.cause)
              : generation.cause,
          );
        if (Exit.isFailure(attempt)) return yield* Effect.failCause(attempt.cause);
        return attempt.value;
      });
    let observers = 0;
    const watch = (target: ChatTarget) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.try({ try: () => V.target(target), catch: ApplicationError.fromUnknown });
          const endpoint = yield* connections.endpoint({ host: target.host });
          const assertGeneration = makeGenerationCheck(
            connections,
            target.host,
            endpoint,
            () =>
              new ApplicationError({
                code: 'Unavailable',
                message: 'Chat stream connection generation changed.',
              }),
          );
          const configuration = yield* call('getChatHost', { host: target.host });
          yield* assertGeneration;
          if (!configuration.features?.includes(chatStreamFeature))
            return Stream.fromEffectSchedule(
              call('getChat', { target }),
              Schedule.spaced('250 millis'),
            );
          return Stream.callback<ChatSnapshot, ApplicationError>(
            (queue) =>
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  Effect.try({
                    try: () => {
                      if (observers >= P.streamLimits.subscriptions)
                        V.fail('Unavailable', 'Chat stream capacity is full.');
                      observers++;
                    },
                    catch: ApplicationError.fromUnknown,
                  }),
                  () =>
                    Effect.sync(() => {
                      observers--;
                    }),
                );
                let last: ChatSnapshot | undefined;
                const publish = (snapshot: ChatSnapshot) => {
                  last = snapshot;
                  Queue.offerUnsafe(queue, snapshot);
                };
                let defects: Cause.Cause<never> = Cause.empty;
                // Registered before child scopes so their actual cleanup settles before this check.
                yield* Effect.addFinalizer(() =>
                  defects.reasons.length ? Effect.failCause(defects) : Effect.void,
                );
                const forkObservation = (effect: Effect.Effect<unknown, ApplicationError>) =>
                  effect.pipe(
                    Effect.onExit((exit) =>
                      Effect.sync(() => {
                        if (Exit.isFailure(exit))
                          defects = Cause.combine(
                            defects,
                            Cause.fromReasons<never>(exit.cause.reasons.filter(Cause.isDieReason)),
                          );
                      }),
                    ),
                    Effect.catchCause((cause) => {
                      const failure = Cause.fromReasons(cause.reasons.filter(Cause.isFailReason));
                      return failure.reasons.length
                        ? Queue.failCause(queue, failure)
                        : Queue.end(queue);
                    }),
                    Effect.forkScoped,
                  );
                // Connection publications abort a held read without introducing a polling timer.
                yield* forkObservation(
                  connections.watch().pipe(Stream.runForEach(() => assertGeneration)),
                );
                // The retry budget spans one outage: back-to-back drops and stalls exhaust it,
                // while a connection proven healthy by a later authenticated frame renews it.
                yield* forkObservation(
                  Effect.gen(function* () {
                    for (let failures = 0; ;) {
                      yield* assertGeneration;
                      let connectedAt: bigint | undefined,
                        renewed = false;
                      const frameArrived = (snapshot: boolean) =>
                        Effect.map(Clock.monotonicTimeNanos, (now) => {
                          if (connectedAt === undefined) {
                            if (snapshot) connectedAt = now;
                          } else if (now - connectedAt >= renewAfterNanos) renewed = true;
                        });
                      // A stream never completes; each end is a failure whose cause decides the retry.
                      const failure = yield* readStream(
                        endpoint,
                        target,
                        assertGeneration,
                        publish,
                        frameArrived,
                      ).pipe(Effect.catchCause((cause) => Effect.succeed(cause)));
                      if (Cause.hasInterruptsOnly(failure)) return yield* Effect.failCause(failure);
                      yield* assertGeneration.pipe(
                        Effect.catchCause((cause) =>
                          Effect.failCause(Cause.combine(failure, cause)),
                        ),
                      );
                      if (last) publish({ ...last, observationStatus: 'reconnecting' });
                      if (renewed) failures = 0;
                      const transient = failure.reasons.every(
                        (reason) =>
                          Cause.isFailReason(reason) && reason.error.code === 'Unavailable',
                      );
                      if (!transient || failures >= P.streamLimits.reconnectMs.length)
                        return yield* Effect.failCause(failure);
                      yield* Effect.sleep(P.streamLimits.reconnectMs[failures++]);
                    }
                  }),
                );
              }),
            { bufferSize: 1, strategy: 'sliding' },
          ).pipe(
            // A failed queue drains buffered replacements before surfacing its error.
            Stream.mapEffect((snapshot) => Effect.as(assertGeneration, snapshot)),
          );
        }),
      );
    return {
      getChatHost: (d) => call('getChatHost', d),
      listChats: (d) => call('listChats', d),
      createChat: (d) => call('createChat', d),
      getChat: (d) => call('getChat', d),
      getChatHistory: (d) => call('getChatHistory', d),
      getChatTranscriptContent: (d) => call('getChatTranscriptContent', d),
      findChatTranscript: (d) => call('findChatTranscript', d),
      getChatHistoryAround: (d) => call('getChatHistoryAround', d),
      sendChat: (d) => call('sendChat', d),
      getChatSend: (d) => call('getChatSend', d),
      stopChat: (d) => call('stopChat', d),
      settleChat: (d) => call('settleChat', d),
      findChatFiles: (d) => call('findChatFiles', d),
      watch: ({ target }) => watch(target),
    } satisfies ChatServiceShape;
  }),
);

type ChatRequest = (
  path: string,
  init: RequestInit,
  lost: () => ApplicationError,
) => Effect.Effect<Response, ApplicationError>;

/** Sends one request to a verified loopback origin; `lost` describes a transport failure. */
const makeChatRequest =
  (origin: string, abort: AbortSignal): ChatRequest =>
  (path, init, lost) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(origin + path, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.any([signal, abort]),
        }),
      catch: lost,
    });

/** Obtains a single-use challenge after verifying its proof and the host's health. */
function authenticateChallenge(
  request: ChatRequest,
  token: string,
  nonce: string,
  host: ChatHostTarget,
): Effect.Effect<string, ApplicationError> {
  return Effect.gen(function* () {
    const response = yield* request(
      '/v1/chat/challenge',
      {
        headers: {
          'X-Moonbase-Nonce': nonce,
          Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge')}`,
        },
      },
      () =>
        new ApplicationError({
          code: 'Unavailable',
          message: 'Chat challenge could not be reached.',
        }),
    );
    const bytes = yield* P.responseBytes(response, 8192);
    return yield* Effect.try({
      try: () => {
        if (
          response.headers.get('x-moonbase-nonce') !== nonce ||
          !P.proof(
            response.headers.get('x-moonbase-proof'),
            P.mac(token, 'challenge-response', nonce, response.status, P.hash(bytes)),
          )
        )
          V.fail('Unauthorized', 'Chat host did not prove its challenge.');
        if (response.status !== 200)
          V.fail('Unavailable', 'Chat host could not issue a challenge.');
        const data = V.object(P.json(bytes));
        validateHostHealth(data.health, host);
        if (!P.validNonce(data.challenge))
          V.fail('Incompatible', 'Chat host returned an invalid challenge.');
        return data.challenge as string;
      },
      catch: (error) =>
        ApplicationError.is(error)
          ? error
          : new ApplicationError({
              code: 'Unavailable',
              message: 'Chat challenge could not be verified within its deadline.',
            }),
    });
  });
}

/** Rebuilds a host failure from its public code alone; host-supplied messages are never shown. */
const publicFailure = (code: (typeof chatReplyErrorCodes)[number], operation?: string) =>
  new ApplicationError({
    code,
    message: P.publicError(new ApplicationError({ code, message: '' }), operation).message,
  });

/** Decodes a signed reply's `error` field; undefined when it carries no public error code. */
function decodeErrorEnvelope(error: unknown, operation?: string): ApplicationError | undefined {
  try {
    const record = V.object(error);
    const code = chatReplyErrorCodes.find((value) => value === record.code);
    return code && publicFailure(code, operation);
  } catch {
    return undefined;
  }
}

/** Fails once the connection no longer serves the endpoint an exchange authenticated against. */
function makeGenerationCheck(
  connections: ConnectionServiceShape,
  host: ChatHostTarget,
  endpoint: VerifiedChatEndpoint,
  changed: () => ApplicationError,
  lookupFailed: (error: ApplicationError) => ApplicationError = (error) => error,
): Effect.Effect<void, ApplicationError> {
  return Effect.flatMap(
    connections.endpoint({ host }).pipe(Effect.mapError(lookupFailed)),
    (current) =>
      current.connectionId === endpoint.connectionId &&
      current.origin === endpoint.origin &&
      current.token === endpoint.token &&
      V.sameHost(current.expected, endpoint.expected)
        ? Effect.void
        : Effect.fail(changed()),
  );
}

function readStream(
  endpoint: VerifiedChatEndpoint,
  target: ChatTarget,
  assertGeneration: Effect.Effect<void, ApplicationError>,
  publish: (snapshot: ChatSnapshot) => void,
  /** Observes each authenticated frame, noting whether it completed a snapshot. */
  frameArrived: (snapshot: boolean) => Effect.Effect<void>,
): Effect.Effect<never, ApplicationError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const state = {
        controller,
        timer: setTimeout(() => controller.abort(), P.streamLimits.establishmentMs),
      };
      return state;
    }),
    (state) =>
      Effect.gen(function* () {
        const nonce = P.nonce(),
          request = makeChatRequest(P.origin(endpoint), state.controller.signal),
          lost = () =>
            new ApplicationError({
              code: 'Unavailable',
              message: 'Chat stream transport was lost.',
            });
        const challenge = yield* authenticateChallenge(request, endpoint.token, nonce, target.host);
        yield* assertGeneration;
        const body = JSON.stringify({ target, connectionId: endpoint.connectionId });
        const stream = yield* request(
          P.streamPath,
          {
            method: 'POST',
            body,
            headers: {
              'content-type': 'application/json',
              'X-Moonbase-Nonce': nonce,
              'X-Moonbase-Challenge': challenge,
              Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.streamMac(endpoint.token, 'request', nonce, challenge, 'POST', P.streamPath, P.hash(body))}`,
            },
          },
          lost,
        );
        if (stream.status !== 200) {
          const bytes = yield* P.responseBytes(stream, 8192);
          yield* Effect.try({
            try: () => {
              if (
                stream.headers.get('x-moonbase-nonce') !== nonce ||
                stream.headers.get('x-moonbase-challenge') !== challenge ||
                !P.proof(
                  stream.headers.get('x-moonbase-proof'),
                  P.mac(endpoint.token, 'response', nonce, challenge, stream.status, P.hash(bytes)),
                )
              )
                V.fail('Unauthorized', 'Chat stream failure could not be authenticated.');
              throw (
                decodeErrorEnvelope(V.object(P.json(bytes)).error) ??
                V.fail('Incompatible', 'Chat stream error is invalid.')
              );
            },
            catch: ApplicationError.fromUnknown,
          });
        }
        let readFailure: { error: unknown } | undefined;
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              if (
                stream.headers.get('content-type') !== 'application/vnd.moonbase.chat-stream-v1' ||
                !stream.body
              )
                V.fail('Incompatible', 'Chat stream response is incompatible.');
              return stream.body!.getReader();
            },
            catch: ApplicationError.fromUnknown,
          }),
          (reader) =>
            Effect.gen(function* () {
              const decoder = new P.FrameDecoder();
              let sequence = 0,
                streamId: string | undefined,
                snapshot: Buffer | undefined,
                used = 0,
                initial = true;
              while (true) {
                const part = yield* Effect.tryPromise({
                  try: () => reader.read(),
                  catch: (error) => {
                    readFailure = { error };
                    return new ApplicationError({
                      code: 'Unavailable',
                      message: 'Chat stream was interrupted.',
                    });
                  },
                });
                if (part.done)
                  return yield* Effect.fail(
                    new ApplicationError({
                      code: 'Unavailable',
                      message: decoder.partial
                        ? 'Chat stream ended in a partial frame.'
                        : 'Chat stream ended; resynchronizing.',
                    }),
                  );
                for (const frame of decoder.push(part.value)) {
                  yield* assertGeneration;
                  const update = yield* Effect.try({
                    try: () => {
                      if (
                        !P.proof(
                          frame.proof,
                          P.streamMac(
                            endpoint.token,
                            'frame',
                            nonce,
                            challenge,
                            P.hash(frame.body),
                          ),
                        )
                      )
                        V.fail('Unauthorized', 'Chat stream frame could not be authenticated.');
                      let value;
                      try {
                        value = decodeChatStreamFrame(P.json(frame.body));
                      } catch {
                        return V.fail('Incompatible', 'Chat stream frame is invalid.');
                      }
                      if (
                        !V.sameTarget(value.target, target) ||
                        value.connectionId !== endpoint.connectionId ||
                        value.sequence !== sequence++ ||
                        (streamId !== undefined && value.streamId !== streamId)
                      )
                        V.fail('Incompatible', 'Chat stream authority or sequence changed.');
                      streamId = value.streamId;
                      if (value.kind === 'error') throw publicFailure(value.code);
                      if (value.kind === 'heartbeat') {
                        if (initial || snapshot)
                          V.fail('Incompatible', 'Chat stream heartbeat interrupted a snapshot.');
                        return;
                      }
                      if (!snapshot) {
                        if (value.offset !== 0)
                          V.fail(
                            'Incompatible',
                            'Chat stream snapshot starts with a missing fragment.',
                          );
                        snapshot = Buffer.allocUnsafe(value.total);
                        used = 0;
                      }
                      const bytes = Buffer.from(value.data, 'base64');
                      if (
                        value.total !== snapshot.length ||
                        value.offset !== used ||
                        used + bytes.length > snapshot.length
                      )
                        V.fail('Incompatible', 'Chat stream snapshot fragments are discontinuous.');
                      snapshot.set(bytes, used);
                      used += bytes.length;
                      if (used === snapshot.length) {
                        const result = V.output('getChat', P.json(snapshot), { target });
                        snapshot = undefined;
                        initial = false;
                        return { ...result, observationStatus: 'connected' as const };
                      }
                    },
                    catch: (error) =>
                      ApplicationError.is(error)
                        ? error
                        : new ApplicationError({
                            code: 'Incompatible',
                            message: 'Chat stream frame is invalid.',
                          }),
                  });
                  if (!initial) {
                    clearTimeout(state.timer);
                    state.timer = setTimeout(() => state.controller.abort(), P.streamLimits.idleMs);
                  }
                  yield* frameArrived(update !== undefined);
                  if (update) {
                    yield* assertGeneration;
                    yield* Effect.sync(() => publish(update));
                  }
                }
              }
            }),
          (reader) =>
            releaseResource(async () => {
              const cancellation = reader.cancel();
              state.controller.abort();
              try {
                await cancellation;
              } catch (error) {
                if (!readFailure || error !== readFailure.error) throw error;
              } finally {
                reader.releaseLock();
              }
            }),
        );
      }),
    (state) =>
      Effect.sync(() => {
        clearTimeout(state.timer);
        state.controller.abort();
      }),
  );
}
