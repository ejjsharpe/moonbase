import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Cause, Effect, Exit, type ManagedRuntime } from 'effect';
import {
  chatContentChunkBytes,
  type ChatClient,
  type ChatStreamRequest,
  type ChatStreamFrame,
} from '@moonbase/contracts/chat';
import { decodeChatStreamRequest } from '@moonbase/contracts/chat-schema';
import type {
  DaemonClient,
  DaemonCommand,
  DaemonInput,
  DaemonOutput,
} from '@moonbase/contracts/daemon';
import {
  decodeDaemonInput,
  decodeDaemonOutput,
  isDaemonCommand,
  isDaemonMutation,
} from '@moonbase/contracts/daemon-schema';
import { LocalHostService, ProviderSetupService } from '@moonbase/contracts/services';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { createHostHealthReply, validateHostHealth } from '@moonbase/ssh/host-health';
import {
  chatHostCapabilities,
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import { releaseResource } from '@moonbase/effect';

import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

export type ChatServerConfiguration = { host: ChatHostTarget; token: string; port: number };
/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;

/**
 * The injected clients are bound to the consumer's process root and shared handlers. They are the
 * trusted local services, which already validate their replies and snapshots; only wire input is
 * decoded here. A local-mode daemon also supplies `daemon`, its folder, control and provider setup
 * operations, and its health then advertises them.
 */
export const serveChat = (
  config: ChatServerConfiguration,
  client: ChatClient,
  daemon?: DaemonClient,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const settings = S.serverConfiguration(config),
          expected = settings.host,
          token = settings.token;
        const health = validateHostHealth(
          {
            ...expected,
            protocol: chatProtocolVersion,
            version: chatHostVersion,
            capabilities: [
              chatHostCapabilities.chat,
              ...(daemon
                ? [
                    chatHostCapabilities.local,
                    chatHostCapabilities.providers,
                    chatHostCapabilities.folders,
                  ]
                : []),
            ],
          },
          expected,
        );
        const configuration = V.output(
          'getChatHost',
          await client.command('getChatHost', { host: expected }),
          { host: expected },
        );
        if (JSON.stringify(configuration).includes(token))
          V.fail(
            'InvalidInput',
            'Keep the private host key separate from public chat identities and settings.',
          );
        if (daemon && !('mode' in configuration))
          V.fail('InvalidInput', 'Serve daemon operations only for a local-mode chat host.');
        const daemonRequests = new Map<
          string,
          { operation: DaemonCommand; input: unknown; outcome: Promise<unknown> }
        >();
        /** Runs one daemon operation; a mutation's request ID binds its whole input. */
        const dispatchDaemon = async <K extends DaemonCommand>(
          operation: K,
          input: DaemonInput<K>,
        ): Promise<DaemonOutput<K>> => {
          const shape = input as { host?: ChatHostTarget; target?: { host: ChatHostTarget } };
          if (!V.sameHost(shape.host ?? shape.target!.host, expected))
            V.fail('Unauthorized', 'Daemon request target differs from this host.');
          const run = async () => {
            const value = decodeDaemonOutput(operation, await daemon!.command(operation, input));
            const requestId = (input as { requestId?: string }).requestId;
            if (
              requestId !== undefined &&
              (value as { requestId?: string }).requestId !== requestId
            )
              V.fail('Unavailable', 'Daemon request identity changed.');
            return value;
          };
          if (!isDaemonMutation(operation)) return run();
          // Keyed by owner too, so one owner's request IDs never answer for another's.
          const { requestId, ownerId } = input as { requestId: string; ownerId?: string },
            key = JSON.stringify([ownerId ?? null, requestId]),
            prior = daemonRequests.get(key);
          if (prior) {
            if (prior.operation !== operation || !areJsonValuesEqual(prior.input, input))
              V.fail('InvalidInput', 'Request ID is bound to another operation or input.');
            return prior.outcome as Promise<DaemonOutput<K>>;
          }
          const outcome = run();
          daemonRequests.set(key, { operation, input, outcome });
          for (const key of daemonRequests.keys()) {
            if (daemonRequests.size <= rememberedDaemonRequests) break;
            daemonRequests.delete(key);
          }
          // A refused request may be sent again; only an outcome that may have applied is kept.
          outcome.catch(() => {
            if (daemonRequests.get(key)?.outcome === outcome) daemonRequests.delete(key);
          });
          return outcome;
        };
        const streamClosures = new Set<Promise<void>>();
        let streamFailure: unknown;
        const grants = new Map<string, { nonce: string; expires: number }>();
        let closed = false,
          active = 0;
        const server = createServer((request, response) => {
          if (active >= 128) {
            response.writeHead(503);
            response.end();
            return;
          }
          active++;
          void handle(request, response)
            .catch(() => {
              if (!response.headersSent) {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: false, error: P.publicError(null) }));
              } else response.destroy();
            })
            .finally(() => {
              active--;
            });
        });
        server.requestTimeout = P.requestDeadlineMs;
        server.headersTimeout = 10000;
        server.maxConnections = 128;
        server.keepAliveTimeout = 1000;
        async function handle(request: IncomingMessage, response: ServerResponse) {
          if (closed) {
            response.writeHead(503);
            response.end();
            return;
          }
          response.setHeader('Cache-Control', 'no-store');
          if (request.method === 'GET' && request.url === '/v1/health') {
            try {
              // The proof is checked first: an unauthenticated probe never reaches the service.
              const value = createHostHealthReply({
                token,
                nonce: request.headers['x-moonbase-nonce'] as string | undefined,
                authorization: request.headers.authorization,
                health,
              });
              await client.command('getChatHost', { host: expected });
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify(value));
            } catch (error) {
              response.writeHead(
                ApplicationError.is(error) && error.code === 'Unauthorized' ? 401 : 503,
                { 'content-type': 'application/json' },
              );
              response.end(JSON.stringify({ ok: false, error: P.publicError(error) }));
            }
            return;
          }
          const clientNonce = request.headers['x-moonbase-nonce'];
          const auth = P.authorization(request.headers.authorization);
          if (!P.validNonce(clientNonce)) {
            response.writeHead(401);
            response.end();
            return;
          }
          const send = (status: number, value: unknown, challenge?: string) => {
            const body = JSON.stringify(value);
            if (Buffer.byteLength(body) > P.maximumChatReplyBytes)
              V.fail('InvalidInput', 'Chat reply exceeds its delivery limit.');
            response.setHeader('X-Moonbase-Nonce', clientNonce);
            if (challenge) response.setHeader('X-Moonbase-Challenge', challenge);
            response.setHeader(
              'X-Moonbase-Proof',
              challenge
                ? P.mac(token, 'response', clientNonce, challenge, status, P.hash(body))
                : P.mac(token, 'challenge-response', clientNonce, status, P.hash(body)),
            );
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(body);
          };
          if (request.method === 'GET' && request.url === '/v1/chat/challenge') {
            if (
              !P.proof(
                auth,
                P.mac(token, 'challenge-request', clientNonce, 'GET', '/v1/chat/challenge'),
              )
            ) {
              response.writeHead(401);
              response.end();
              return;
            }
            try {
              await client.command('getChatHost', { host: expected });
              const now = performance.now();
              for (const [challenge, grant] of grants)
                if (grant.expires <= now) grants.delete(challenge);
              if (grants.size >= 128)
                return send(429, {
                  ok: false,
                  error: {
                    code: 'Unavailable',
                    message: 'Chat authentication capacity is full; retry later.',
                  },
                });
              const challenge = P.nonce();
              grants.set(challenge, { nonce: clientNonce, expires: now + P.requestDeadlineMs });
              send(200, { challenge, health });
            } catch (error) {
              send(503, { ok: false, error: P.publicError(error) });
            }
            return;
          }
          const streaming = request.url === P.streamPath;
          if (request.method !== 'POST' || (!streaming && request.url !== '/v1/chat')) {
            response.writeHead(404);
            response.end();
            return;
          }
          const challenge = request.headers['x-moonbase-challenge'];
          if (!P.validNonce(challenge)) {
            response.writeHead(401);
            response.end();
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0,
            authenticated = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let dispatchedOperation: string | undefined,
            daemonOperation = false;
          try {
            timer = setTimeout(() => request.destroy(), P.requestDeadlineMs);
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
              V.fail('InvalidInput', 'Chat request must be JSON.');
            for await (const chunk of request) {
              length += chunk.length;
              if (length > (streaming ? P.streamLimits.requestBytes : P.maximumChatRequestBytes))
                V.fail('InvalidInput', 'Chat input exceeds its transport limit.');
              chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks, length),
              grant = grants.get(challenge);
            if (
              !grant ||
              grant.nonce !== clientNonce ||
              grant.expires <= performance.now() ||
              !P.proof(
                auth,
                streaming
                  ? P.streamMac(
                      token,
                      'request',
                      clientNonce,
                      challenge,
                      'POST',
                      P.streamPath,
                      P.hash(bytes),
                    )
                  : P.mac(
                      token,
                      'request',
                      clientNonce,
                      challenge,
                      'POST',
                      '/v1/chat',
                      P.hash(bytes),
                    ),
              )
            ) {
              response.writeHead(401);
              response.end();
              return;
            }
            // No await may separate checking a grant from consuming it.
            grants.delete(challenge);
            authenticated = true;
            if (streaming) {
              const input = decodeChatStreamRequest(P.json(bytes));
              if (!V.sameHost(input.target.host, expected))
                V.fail('Unauthorized', 'Chat stream target differs from this host.');
              if (streamClosures.size >= P.streamLimits.subscriptions)
                V.fail('Unavailable', 'Chat stream capacity is full.');
              clearTimeout(timer);
              const work = streamChat(response, client, input, token, clientNonce, challenge);
              streamClosures.add(work);
              try {
                await work;
              } catch (error) {
                streamFailure ??= error;
                throw error;
              } finally {
                streamClosures.delete(work);
              }
              return;
            }
            const envelope = V.object(P.json(bytes), ['operation', 'input']);
            if (daemon && isDaemonCommand(envelope.operation)) {
              daemonOperation = true;
              const operation = envelope.operation,
                input = decodeDaemonInput(operation, envelope.input);
              dispatchedOperation = operation;
              send(200, { ok: true, value: await dispatchDaemon(operation, input) }, challenge);
              return;
            }
            const operation = V.command(envelope.operation),
              input = V.input(operation, envelope.input);
            dispatchedOperation = operation;
            const controller = new AbortController();
            const cancelRead = () => {
              if (!response.writableEnded) controller.abort();
            };
            response.once('close', cancelRead);
            try {
              const value = await client.command(
                operation,
                input,
                V.isCancellableRead(operation) ? { signal: controller.signal } : undefined,
              );
              send(
                200,
                {
                  ok: true,
                  value,
                },
                challenge,
              );
            } finally {
              response.off('close', cancelRead);
            }
          } catch (error) {
            if (response.headersSent) response.destroy();
            else if (authenticated)
              send(
                400,
                {
                  ok: false,
                  error: daemonOperation
                    ? P.publicDaemonError(error)
                    : P.publicError(error, dispatchedOperation),
                },
                challenge,
              );
            else if (!response.destroyed) {
              response.writeHead(400);
              response.end();
            }
          } finally {
            clearTimeout(timer);
          }
        }
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(settings.port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === 'string')
          V.fail('Unavailable', 'Chat loopback listener did not open.');
        return {
          origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
          close: async () => {
            closed = true;
            grants.clear();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            });
            await Promise.allSettled(streamClosures);
            if (streamFailure) throw streamFailure;
          },
        };
      },
      catch: (error) =>
        ApplicationError.is(error)
          ? error
          : new ApplicationError({
              code: 'Unavailable',
              message: 'Chat host could not acquire its loopback listener or backing service.',
            }),
    }),
    (server) => releaseResource(() => server.close()),
  );

/**
 * Binds a process root's folder, control and provider setup services to the daemon operations
 * `serveChat` serves; the server has checked each input's host.
 */
export function makeDaemonClient(
  runtime: ManagedRuntime.ManagedRuntime<LocalHostService | ProviderSetupService, unknown>,
): DaemonClient {
  const run = async <A>(
    effect: Effect.Effect<A, ApplicationError, LocalHostService | ProviderSetupService>,
  ) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    throw ApplicationError.is(error)
      ? error
      : new ApplicationError({ code: 'Unavailable', message: 'Daemon operation failed.' });
  };
  const handlers: { [K in DaemonCommand]: (input: DaemonInput<K>) => Promise<DaemonOutput<K>> } = {
    approveFolder: (input) => run(Effect.flatMap(LocalHostService, (s) => s.approveFolder(input))),
    listRecentFolders: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.listRecentFolders(input))),
    checkChatFolder: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.checkChatFolder(input))),
    getActiveWork: (input) => run(Effect.flatMap(LocalHostService, (s) => s.getActiveWork(input))),
    markFolderAsProject: (input) =>
      run(Effect.flatMap(LocalHostService, (s) => s.markFolderAsProject(input))),
    getProviders: ({ ownerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).getProviders({}), (state) => ({ state })),
        ),
      ),
    startProviderLogin: ({ ownerId, requestId, providerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).startProviderLogin({ providerId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    answerProviderPrompt: ({ ownerId, requestId, flowId, promptId, answer }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(
            s.forOwner(ownerId).answerProviderPrompt({ flowId, promptId, answer }),
            (state) => ({ requestId, state }),
          ),
        ),
      ),
    cancelProviderLogin: ({ ownerId, requestId, flowId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).cancelProviderLogin({ flowId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    openProviderUrl: ({ ownerId, flowId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.flatMap(s.getProviderUrl(ownerId, flowId), (url) =>
            Effect.map(s.forOwner(ownerId).getProviders({}), (state) => ({ state, url })),
          ),
        ),
      ),
    logoutProvider: ({ ownerId, requestId, providerId }) =>
      run(
        Effect.flatMap(ProviderSetupService, (s) =>
          Effect.map(s.forOwner(ownerId).logoutProvider({ providerId }), (state) => ({
            requestId,
            state,
          })),
        ),
      ),
    releaseProviderOwner: ({ ownerId }) =>
      run(Effect.flatMap(ProviderSetupService, (s) => s.releaseOwner(ownerId))),
  };
  return {
    command: (operation, input) => {
      if (!Object.hasOwn(handlers, operation))
        return Promise.reject(
          new ApplicationError({ code: 'InvalidInput', message: 'Unknown daemon operation.' }),
        );
      return (handlers[operation] as (input: unknown) => Promise<never>)(input);
    },
  };
}

/** One pending replacement and one being written; watches never trigger an RPC read. */
async function streamChat(
  response: ServerResponse,
  client: ChatClient,
  input: ChatStreamRequest,
  token: string,
  nonce: string,
  challenge: string,
) {
  const controller = new AbortController();
  let pending: Buffer | undefined, terminal: ReturnType<typeof P.publicError> | undefined;
  let wake: (() => void) | undefined,
    active = true,
    sequence = 0,
    heartbeatDue = false;
  const streamId = P.nonce();
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const stop = () => {
    active = false;
    controller.abort();
    notify();
  };
  response.once('close', stop);
  response.once('error', stop);
  const deadline = setTimeout(stop, P.streamLimits.establishmentMs);
  // Only a full interval without any frame earns a heartbeat; none precedes the first frame.
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const scheduleHeartbeat = () => {
    heartbeatDue = false;
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      heartbeatDue = true;
      notify();
    }, P.streamLimits.heartbeatMs);
  };
  let close: ReturnType<ChatClient['watch']> | undefined;
  const write = async <Frame extends ChatStreamFrame>(
    frame: Frame extends ChatStreamFrame
      ? Omit<Frame, keyof ChatStreamRequest | 'streamId' | 'sequence'>
      : never,
  ) => {
    if (!active) return;
    if (!Number.isSafeInteger(sequence)) V.fail('Incompatible', 'Chat stream sequence exhausted.');
    const bytes = P.encodeFrame(token, nonce, challenge, {
      ...input,
      streamId,
      sequence: sequence++,
      ...frame,
    });
    if (!response.headersSent)
      response.writeHead(200, { 'content-type': 'application/vnd.moonbase.chat-stream-v1' });
    scheduleHeartbeat();
    if (response.write(bytes)) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        response.off('drain', done);
        controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(stop, P.streamLimits.drainMs);
      response.once('drain', done);
      controller.signal.addEventListener('abort', done, { once: true });
      if (!active) done();
    });
  };
  try {
    close = client.watch(
      { target: input.target },
      (snapshot) => {
        if (!active || terminal) return;
        try {
          const bytes = Buffer.from(JSON.stringify(snapshot));
          if (bytes.length > P.maximumChatReplyBytes)
            V.fail('InvalidInput', 'Chat reply exceeds its delivery limit.');
          pending = bytes;
        } catch (error) {
          terminal = P.publicError(error);
          pending = undefined;
        }
        notify();
      },
      (error) => {
        if (active) {
          terminal = P.publicError(error);
          pending = undefined;
          notify();
        }
      },
    );
    while (active) {
      if (terminal) {
        await write({
          kind: 'error',
          code: terminal.code === 'Uncertain' ? 'Unavailable' : terminal.code,
        });
        clearTimeout(deadline);
        if (active)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              response.off('finish', done);
              controller.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(stop, P.streamLimits.drainMs);
            response.once('finish', done);
            controller.signal.addEventListener('abort', done, { once: true });
            response.end();
            if (response.writableFinished || !active) done();
          });
        break;
      }
      if (pending) {
        const bytes = pending;
        pending = undefined;
        for (let offset = 0; offset < bytes.length && active; offset += chatContentChunkBytes)
          await write({
            kind: 'snapshot',
            offset,
            total: bytes.length,
            data: bytes.subarray(offset, offset + chatContentChunkBytes).toString('base64'),
          });
        clearTimeout(deadline);
      } else {
        if (heartbeatDue) await write({ kind: 'heartbeat' });
        if (active && !pending && !terminal)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    }
  } finally {
    stop();
    clearTimeout(deadline);
    clearTimeout(heartbeat);
    response.off('close', stop);
    response.off('error', stop);
    // A completed terminal response must keep its flushed bytes on the socket.
    if (!response.writableFinished) response.destroy();
    await close?.();
  }
}
