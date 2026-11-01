import { Effect, Layer, Stream, Schedule, Exit, Cause } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import type {
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatTarget,
} from '@moonbase/application/chat-client';
import {
  ChatService,
  ConnectionService,
  type ChatServiceShape,
} from '@moonbase/application/services';
import { validateHostHealth } from '@moonbase/application/host-health';
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
        const mutation =
          operation === 'createChat' || operation === 'sendChat' || operation === 'stopChat';
        let dispatched = false;
        const shape = input as {
          host?: { hostId: string; storeId: string };
          session?: { host: { hostId: string; storeId: string } };
          target?: ChatTarget;
          stop?: { target: ChatTarget };
        };
        const host =
          shape.host ?? shape.session?.host ?? shape.target?.host ?? shape.stop!.target.host;
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
              if (Buffer.byteLength(body) > 64 * 1024)
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
                      message: P.publicError(new ApplicationError({ code, message: '' })).message,
                    });
                  }
                  if (envelope.ok !== true || response.status !== 200)
                    return invalid('Incompatible', 'Chat reply has an unexpected status or shape.');
                  try {
                    return V.output(operation, envelope.value, input);
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
    return {
      getChatHost: (d) => call('getChatHost', d),
      listChats: (d) => call('listChats', d),
      createChat: (d) => call('createChat', d),
      getChat: (d) => call('getChat', d),
      getChatHistory: (d) => call('getChatHistory', d),
      sendChat: (d) => call('sendChat', d),
      getChatSend: (d) => call('getChatSend', d),
      stopChat: (d) => call('stopChat', d),
      watch: ({ target }) =>
        Stream.fromEffectSchedule(call('getChat', { target }), Schedule.spaced('250 millis')),
    } satisfies ChatServiceShape;
  }),
);
