import { Effect, Layer, Stream, Schedule, Exit, Cause, Queue } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  chatStreamFeature,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
  type ChatTarget,
  type ChatSnapshot,
} from '@moonbase/contracts/chat';
import { decodeChatStreamFrame } from '@moonbase/contracts/chat-schema';
import { releaseResource } from '@moonbase/effect';
import {
  ChatService,
  ConnectionService,
  type ChatServiceShape,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { validateHostHealth } from '@moonbase/ssh/host-health';
import * as P from './protocol.ts';
import * as V from './validation.ts';

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
        const mutation =
          operation === 'createChat' || operation === 'sendChat' || operation === 'stopChat';
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
        const assertGeneration = Effect.flatMap(
          connections
            .endpoint({ host })
            .pipe(Effect.mapError((error) => (mutation && dispatched ? changed() : error))),
          (current) =>
            current.connectionId === endpoint.connectionId &&
            current.origin === endpoint.origin &&
            current.token === endpoint.token &&
            V.sameHost(current.expected, endpoint.expected)
              ? Effect.void
              : Effect.fail(changed()),
        );
        const prepared = yield* Effect.try({
          try: () => ({ origin: P.origin(endpoint), nonce: P.nonce() }),
          catch: ApplicationError.fromUnknown,
        });
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 20000);
        const attempt = yield* Effect.exit(
          Effect.ensuring(
            Effect.gen(function* () {
              const challengeResponse = yield* Effect.tryPromise({
                try: (signal) =>
                  fetch(`${prepared.origin}/v1/chat/challenge`, {
                    headers: {
                      'X-Moonbase-Nonce': prepared.nonce,
                      Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token, 'challenge-request', prepared.nonce, 'GET', '/v1/chat/challenge')}`,
                    },
                    redirect: 'error',
                    signal: AbortSignal.any([signal, controller.signal]),
                    cache: 'no-store',
                    credentials: 'omit',
                  }),
                catch: () =>
                  new ApplicationError({
                    code: 'Unavailable',
                    message: 'Chat challenge could not be reached.',
                  }),
              });
              const challengeBytes = yield* P.responseBytes(challengeResponse, 8192);
              const challenge = yield* Effect.try({
                try: () => {
                  const response = challengeResponse,
                    bytes = challengeBytes;
                  if (
                    response.headers.get('x-moonbase-nonce') !== prepared.nonce ||
                    !P.proof(
                      response.headers.get('x-moonbase-proof'),
                      P.mac(
                        endpoint.token,
                        'challenge-response',
                        prepared.nonce,
                        response.status,
                        P.hash(bytes),
                      ),
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
              yield* assertGeneration;
              const body = JSON.stringify({ operation, input });
              if (Buffer.byteLength(body) > P.maximumChatRequestBytes)
                return yield* Effect.fail(
                  new ApplicationError({
                    code: 'InvalidInput',
                    message: 'Chat input exceeds its transport limit.',
                  }),
                );
              const response = yield* Effect.tryPromise({
                try: (signal) => {
                  dispatched = true;
                  return fetch(`${prepared.origin}/v1/chat`, {
                    method: 'POST',
                    body,
                    headers: {
                      'content-type': 'application/json',
                      'X-Moonbase-Nonce': prepared.nonce,
                      'X-Moonbase-Challenge': challenge,
                      Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token, 'request', prepared.nonce, challenge, 'POST', '/v1/chat', P.hash(body))}`,
                    },
                    redirect: 'error',
                    signal: AbortSignal.any([signal, controller.signal]),
                    cache: 'no-store',
                    credentials: 'omit',
                  });
                },
                catch: () =>
                  new ApplicationError({
                    code: mutation ? 'Uncertain' : 'Unavailable',
                    message: mutation
                      ? 'Chat reply was lost. Query the original request; do not invent another Send.'
                      : 'Chat reply was lost. Retry the read through the selected authority.',
                  }),
              });
              const bytes = yield* P.responseBytes(
                response,
                256 * 1024,
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
                  if (envelope.ok === false) {
                    let code: (typeof P.codes)[number] | undefined;
                    try {
                      const error = V.object(envelope.error);
                      code = P.codes.find((value) => value === error.code);
                    } catch {
                      return invalid('Incompatible', 'Chat returned an invalid error.');
                    }
                    if (!code) return invalid('Incompatible', 'Chat returned an invalid error.');
                    throw new ApplicationError({
                      code,
                      message: P.publicError(new ApplicationError({ code, message: '' }), operation)
                        .message,
                    });
                  }
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
                catch: (error) =>
                  ApplicationError.is(error)
                    ? error
                    : new ApplicationError({
                        code: mutation ? 'Uncertain' : 'Unavailable',
                        message: mutation
                          ? 'Chat reply was lost. Query the original request; do not invent another Send.'
                          : 'Chat reply was lost. Retry the read through the selected authority.',
                      }),
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
          const assertGeneration = Effect.flatMap(
            connections.endpoint({ host: target.host }),
            (current) =>
              current.connectionId === endpoint.connectionId &&
              current.origin === endpoint.origin &&
              current.token === endpoint.token &&
              V.sameHost(current.expected, endpoint.expected)
                ? Effect.void
                : Effect.fail(
                    new ApplicationError({
                      code: 'Unavailable',
                      message: 'Chat stream connection generation changed.',
                    }),
                  ),
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
                // Connection publications abort a held read without introducing a polling timer.
                yield* connections.watch().pipe(
                  Stream.runForEach(() => assertGeneration),
                  Effect.catchCause((cause) => Queue.failCause(queue, cause)),
                  Effect.forkScoped,
                );
                yield* Effect.gen(function* () {
                  for (let attempt = 0; ; attempt++) {
                    yield* assertGeneration;
                    const result = yield* Effect.exit(
                      readStream(endpoint, target, assertGeneration, publish),
                    );
                    if (Exit.isSuccess(result)) return;
                    if (Cause.hasInterruptsOnly(result.cause))
                      return yield* Effect.failCause(result.cause);
                    yield* assertGeneration.pipe(
                      Effect.catchCause((cause) =>
                        Effect.failCause(Cause.combine(result.cause, cause)),
                      ),
                    );
                    if (last) publish({ ...last, observationStatus: 'reconnecting' });
                    const transient = result.cause.reasons.every(
                      (reason) => Cause.isFailReason(reason) && reason.error.code === 'Unavailable',
                    );
                    if (!transient || attempt >= P.streamLimits.reconnectMs.length)
                      return yield* Effect.failCause(result.cause);
                    yield* Effect.sleep(P.streamLimits.reconnectMs[attempt]);
                  }
                }).pipe(
                  Effect.catchCause((cause) => Queue.failCause(queue, cause)),
                  Effect.forkScoped,
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
      getChatHistoryAround: (d) => call('getChatHistoryAround', d),
      sendChat: (d) => call('sendChat', d),
      getChatSend: (d) => call('getChatSend', d),
      stopChat: (d) => call('stopChat', d),
      watch: ({ target }) => watch(target),
    } satisfies ChatServiceShape;
  }),
);

function readStream(
  endpoint: VerifiedChatEndpoint,
  target: ChatTarget,
  assertGeneration: Effect.Effect<void, ApplicationError>,
  publish: (snapshot: ChatSnapshot) => void,
) {
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
          origin = P.origin(endpoint);
        const request = (path: string, init: RequestInit) =>
          Effect.tryPromise({
            try: (signal) =>
              fetch(origin + path, {
                ...init,
                redirect: 'error',
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.any([signal, state.controller.signal]),
              }),
            catch: () =>
              new ApplicationError({
                code: 'Unavailable',
                message: 'Chat stream transport was lost.',
              }),
          });
        const response = yield* request('/v1/chat/challenge', {
          headers: {
            'X-Moonbase-Nonce': nonce,
            Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge')}`,
          },
        });
        const challengeBytes = yield* P.responseBytes(response, 8192);
        const challenge = yield* Effect.try({
          try: () => {
            if (
              response.headers.get('x-moonbase-nonce') !== nonce ||
              !P.proof(
                response.headers.get('x-moonbase-proof'),
                P.mac(
                  endpoint.token,
                  'challenge-response',
                  nonce,
                  response.status,
                  P.hash(challengeBytes),
                ),
              )
            )
              V.fail('Unauthorized', 'Chat stream challenge could not be authenticated.');
            if (response.status !== 200)
              V.fail('Unavailable', 'Chat stream challenge is unavailable.');
            const data = V.object(P.json(challengeBytes));
            validateHostHealth(data.health, target.host);
            if (!P.validNonce(data.challenge))
              V.fail('Incompatible', 'Chat stream challenge is invalid.');
            return data.challenge as string;
          },
          catch: ApplicationError.fromUnknown,
        });
        yield* assertGeneration;
        const body = JSON.stringify({ target, connectionId: endpoint.connectionId });
        const stream = yield* request(P.streamPath, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            'X-Moonbase-Nonce': nonce,
            'X-Moonbase-Challenge': challenge,
            Authorization: `Moonbase-RPC-HMAC-SHA256 ${P.streamMac(endpoint.token, 'request', nonce, challenge, 'POST', P.streamPath, P.hash(body))}`,
          },
        });
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
              const data = V.object(P.json(bytes)),
                error = V.object(data.error);
              if (!P.codes.includes(error.code as (typeof P.codes)[number]))
                V.fail('Incompatible', 'Chat stream error is invalid.');
              throw new ApplicationError({
                code: error.code as (typeof P.codes)[number],
                message: P.publicError(
                  new ApplicationError({
                    code: error.code as (typeof P.codes)[number],
                    message: '',
                  }),
                ).message,
              });
            },
            catch: ApplicationError.fromUnknown,
          });
        }
        let readFailure: { error: unknown } | undefined;
        yield* Effect.acquireUseRelease(
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
                      if (value.kind === 'error')
                        throw new ApplicationError({
                          code: value.code,
                          message: P.publicError(
                            new ApplicationError({ code: value.code, message: '' }),
                          ).message,
                        });
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
