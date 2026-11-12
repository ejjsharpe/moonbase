import type { ChatCommand, ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import type { DaemonCommand, DaemonInput, DaemonOutput } from '@moonbase/contracts/daemon';
import {
  daemonCommandCapabilities,
  decodeDaemonInput,
  decodeDaemonOutput,
  isDaemonCommand,
  isDaemonMutation,
} from '@moonbase/contracts/daemon-schema';
import { chatHostCapabilities, type ChatHostHealth } from '@moonbase/contracts/host';
import type { HostCommand, HostInput, HostOutput } from '@moonbase/contracts/workspace-host';
import {
  decodeHostInput,
  decodeHostOutput,
  isHostCommand,
  isHostMutation,
} from '@moonbase/contracts/workspace-host-schema';
import { chatReplyErrorCodes } from '@moonbase/contracts/chat-schema';
import type { CommandOptions } from '@moonbase/contracts/common';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import {
  applySocketDelta,
  socketLimits,
  socketPath,
  type SocketServerMessage,
  type SocketSubscriptionKind,
  type SocketSubscriptionTarget,
  type SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import {
  decodeSocketChallenge,
  decodeSocketDelta,
  decodeSocketReply,
  decodeSocketServerMessage,
  decodeSocketSubscriptionValue,
} from '@moonbase/contracts/socket-schema';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { validateHostHealth } from '@moonbase/ssh/host-health';
import * as P from './protocol.ts';
import * as V from './validation.ts';
import {
  deriveSocketKeys,
  openSocketMessage,
  PayloadReassembly,
  sealSocketMessage,
  systemSocketClock,
  type SocketClock,
  type SocketKeys,
} from './socket-protocol.ts';

export type SocketOperation = ChatCommand | DaemonCommand | HostCommand;
export type SocketInput<K extends SocketOperation> = K extends ChatCommand
  ? ChatInput<K>
  : K extends DaemonCommand
    ? DaemonInput<K>
    : K extends HostCommand
      ? HostInput<K>
      : never;
export type SocketOutput<K extends SocketOperation> = K extends ChatCommand
  ? ChatOutput<K>
  : K extends DaemonCommand
    ? DaemonOutput<K>
    : K extends HostCommand
      ? HostOutput<K>
      : never;
/** Where a subscription stood: given to a new connection's `subscribe`, it resumes from there. */
export type SocketSubscriptionState<K extends SocketSubscriptionKind> = {
  subscriptionId: string;
  sequence: number;
  value: SocketSubscriptionValue<K>;
};
export type SocketSubscription<K extends SocketSubscriptionKind> = {
  readonly subscriptionId: string;
  /** The update last applied and its value, once one arrived. */
  readonly state: SocketSubscriptionState<K> | undefined;
  close(): void;
};
export type DaemonSocket = {
  /** The daemon's health, authenticated by the welcome. */
  readonly health: ChatHostHealth;
  request<K extends SocketOperation>(
    operation: K,
    input: SocketInput<K>,
    options?: CommandOptions,
  ): Promise<SocketOutput<K>>;
  subscribe<K extends SocketSubscriptionKind>(
    kind: K,
    target: SocketSubscriptionTarget<K>,
    handlers: {
      receive(value: SocketSubscriptionValue<K>, update: 'snapshot' | 'delta'): void;
      /**
       * The subscription ended (`connectionClosed` false: the daemon ended it) or its connection
       * did; it is never resubscribed by itself.
       */
      onError(error: ApplicationError, connectionClosed: boolean): void;
    },
    resume?: SocketSubscriptionState<K>,
  ): SocketSubscription<K>;
  /** The clock time of the latest authenticated message, heartbeats included. */
  readonly lastReceived: number;
  /** Resolves with why the connection closed. */
  readonly closed: Promise<ApplicationError>;
  /** Closes the connection; resolves once its socket has closed, so the daemon has seen it end. */
  close(): Promise<void>;
};

/** Rebuilds a daemon failure from its public code alone; its messages are never shown. */
const publicFailure = (code: (typeof chatReplyErrorCodes)[number], operation?: string) =>
  new ApplicationError({
    code,
    message: P.publicError(new ApplicationError({ code, message: '' }), operation).message,
  });
/**
 * Decodes a signed reply's `error` field; undefined when it carries no public error code. A daemon
 * operation's failure may name a reason, shown with the client's own fixed text.
 */
export function decodeErrorEnvelope(
  error: unknown,
  operation?: string,
): ApplicationError | undefined {
  try {
    const record = V.object(error);
    const code = chatReplyErrorCodes.find((value) => value === record.code);
    if (code && (isDaemonCommand(operation) || isHostCommand(operation)))
      return P.daemonFailure(code, record.reason);
    return code && publicFailure(code, operation);
  } catch {
    return undefined;
  }
}

const unavailable = (message = 'The daemon connection closed.') =>
  new ApplicationError({ code: 'Unavailable', message });
/** A reply that fails to decode: a mutation's outcome is then unknown. */
const invalidReply = (mutation: boolean) =>
  mutation
    ? new ApplicationError({
        code: 'Uncertain',
        message:
          'The daemon’s reply to a mutation was invalid. Preserve its original request and check its outcome before retrying.',
      })
    : new ApplicationError({ code: 'Incompatible', message: 'The daemon sent an invalid reply.' });

/**
 * Opens one authenticated WebSocket to a daemon that advertises `socket-v1`. A request whose
 * reply is lost with the connection fails `Uncertain` when it is a mutation and `Unavailable`
 * otherwise; nothing is ever sent again on another connection.
 */
export function connectDaemonSocket(
  endpoint: ChatHostEndpoint,
  options: { clock?: SocketClock } = {},
): Promise<DaemonSocket> {
  const clock = options.clock ?? systemSocketClock,
    origin = P.origin(endpoint),
    token = endpoint.token,
    expected = endpoint.expected;
  const socket = new WebSocket(`ws${origin.slice(4)}${socketPath}`);
  socket.binaryType = 'arraybuffer';
  const nonce = P.nonce();
  let keys: SocketKeys | undefined,
    health: ChatHostHealth | undefined,
    sent = 0,
    received = 0,
    lastSent = clock.now(),
    lastReceived = clock.now(),
    timer: unknown,
    nextId = 0,
    reason: ApplicationError | undefined;
  const assembler = new PayloadReassembly();
  // Chunked workspace requests hold their input until answered; the daemon closes a connection
  // that holds more than `workspaceInFlightBytes`, so a request that would pass it waits.
  let chunkedInFlight = 0;
  const waiting: (() => boolean)[] = [];
  const acquire = (bytes: number) =>
    new Promise<void>((resolve) => {
      const take = () => {
        if (chunkedInFlight + bytes > socketLimits.workspaceInFlightBytes) return false;
        chunkedInFlight += bytes;
        resolve();
        return true;
      };
      if (!waiting.length && take()) return;
      waiting.push(take);
    });
  const release = (bytes: number) => {
    chunkedInFlight -= bytes;
    while (waiting.length && waiting[0]!()) waiting.shift();
  };
  /** Input a cancelled chunked request holds until the daemon's reply to it arrives. */
  const abandoned = new Map<string, number>();
  type Pending = {
    operation: SocketOperation;
    mutation: boolean;
    resolve(value: unknown): void;
    reject(error: ApplicationError): void;
  };
  const requests = new Map<string, Pending>();
  type Subscription = {
    kind: SocketSubscriptionKind;
    target: SocketSubscriptionTarget<SocketSubscriptionKind>;
    state?: SocketSubscriptionState<SocketSubscriptionKind>;
    receive(value: unknown, update: 'snapshot' | 'delta'): void;
    onError(error: ApplicationError, connectionClosed: boolean): void;
  };
  const subscriptions = new Map<string, Subscription>();
  let settle!: (value: DaemonSocket) => void, refuse!: (error: ApplicationError) => void;
  const connected = new Promise<DaemonSocket>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  let resolveClosed!: (error: ApplicationError) => void;
  const closed = new Promise<ApplicationError>((resolve) => (resolveClosed = resolve));

  /** Ends the connection once; requests in flight and subscriptions learn why. */
  const end = (error: ApplicationError) => {
    if (reason) return;
    reason = error;
    clock.clearTimeout(timer);
    try {
      socket.close();
    } catch {}
    refuse(error);
    for (const pending of requests.values())
      pending.reject(
        pending.mutation
          ? new ApplicationError({
              code: 'Uncertain',
              message:
                'The daemon connection closed after a mutation was sent. Preserve its original request and check its outcome before retrying.',
            })
          : error,
      );
    requests.clear();
    for (const subscription of subscriptions.values()) subscription.onError(error, true);
    subscriptions.clear();
    resolveClosed(error);
  };
  const send = (message: Record<string, unknown>) => {
    if (reason || !keys) throw reason ?? unavailable();
    socket.send(sealSocketMessage(keys.client, { ...message, seq: sent++ }));
    lastSent = clock.now();
  };
  const schedule = () => {
    const due = Math.min(lastSent + socketLimits.heartbeatMs, lastReceived + socketLimits.idleMs);
    timer = clock.setTimeout(
      () => {
        if (reason) return;
        const now = clock.now();
        if (now - lastReceived >= socketLimits.idleMs) return end(unavailable());
        if (now - lastSent >= socketLimits.heartbeatMs) send({ type: 'heartbeat' });
        schedule();
      },
      Math.max(0, due - clock.now()),
    );
  };
  timer = clock.setTimeout(
    () => end(unavailable('The daemon did not complete its handshake.')),
    socketLimits.connectMs,
  );

  const receive = (message: SocketServerMessage) => {
    if (message.type === 'heartbeat') return;
    if (message.type === 'welcome') return V.fail('Incompatible', 'Unexpected welcome.');
    if (message.type === 'reply') {
      const pending = requests.get(message.id);
      // Only a workspace reply, or the late reply to a cancelled one, may exceed a chat reply's bound.
      const done = assembler.push(
        `reply:${message.id}`,
        message,
        (pending && isHostCommand(pending.operation)) || abandoned.has(message.id)
          ? socketLimits.workspaceReplyBytes
          : socketLimits.payloadBytes,
      );
      if (!done) return;
      const held = abandoned.get(message.id);
      if (held !== undefined) {
        abandoned.delete(message.id);
        release(held);
      }
      if (!pending) return;
      requests.delete(message.id);
      let reply: ReturnType<typeof decodeSocketReply>;
      try {
        reply = decodeSocketReply(done.value);
      } catch {
        return pending.reject(invalidReply(pending.mutation));
      }
      if (reply.ok) pending.resolve(reply.value);
      else
        pending.reject(
          decodeErrorEnvelope(reply.error, pending.operation) ?? invalidReply(pending.mutation),
        );
      return;
    }
    // A delta cannot follow a snapshot of its own subscription that is still arriving.
    if (message.kind !== 'snapshot' && assembler.partial(`update:${message.subscriptionId}:`))
      V.fail('Incompatible', 'Socket payload was interrupted.');
    const subscription = subscriptions.get(message.subscriptionId);
    if (message.kind === 'error') {
      if (!subscription) return;
      subscriptions.delete(message.subscriptionId);
      subscription.onError(P.daemonFailure(message.code, undefined), false);
      return;
    }
    const sequence = message.sequence;
    let value: unknown, update: 'snapshot' | 'delta';
    if (message.kind === 'snapshot') {
      const done = assembler.push(`update:${message.subscriptionId}:${sequence}`, message);
      if (!done || !subscription) return;
      value = done.value;
      update = 'snapshot';
    } else {
      if (!subscription) return;
      const state = subscription.state;
      if (!state || state.sequence !== message.base)
        V.fail('Incompatible', 'Socket delta does not follow the update before it.');
      value = applySocketDelta(
        subscription.kind,
        state!.value,
        decodeSocketDelta(subscription.kind, message.delta),
      );
      update = 'delta';
    }
    const decoded = decodeSocketSubscriptionValue(subscription.kind, value);
    if (subscription.kind === 'chat')
      V.output('getChat', decoded, {
        target: subscription.target as SocketSubscriptionTarget<'chat'>,
      });
    if (subscription.kind === 'chatList') {
      // Every row, on the first page or past it, stays within the watched host and actor.
      const { list, changed } = decoded as SocketSubscriptionValue<'chatList'>,
        session = subscription.target as SocketSubscriptionTarget<'chatList'>;
      V.output('listChats', list, { session });
      V.output('listChats', { conversations: changed, nextCursor: null }, { session });
    }
    subscription.state = {
      subscriptionId: message.subscriptionId,
      sequence,
      value: decoded,
    };
    subscription.receive(decoded, update);
  };

  socket.addEventListener('message', (event) => {
    if (reason) return;
    try {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes.length > socketLimits.frameBytes)
        V.fail('Incompatible', 'Socket message is too large.');
      lastReceived = clock.now();
      if (!keys) {
        // The challenge, unauthenticated: the hello answers it under keys it binds.
        const challenge = decodeSocketChallenge(P.json(bytes));
        keys = deriveSocketKeys(token, { nonce, challenge: challenge.challenge, host: expected });
        send({ type: 'hello', protocol: challenge.protocol, host: expected, nonce });
        return;
      }
      const message = decodeSocketServerMessage(openSocketMessage(keys.server, bytes));
      if (message.seq !== received++) V.fail('Unauthorized', 'Socket message is out of sequence.');
      if (!health) {
        if (message.type !== 'welcome') V.fail('Incompatible', 'Expected a welcome.');
        const welcome = message as Extract<SocketServerMessage, { type: 'welcome' }>;
        health = validateHostHealth(welcome.health, expected);
        if (!health.capabilities.includes(chatHostCapabilities.socket))
          V.fail('Incompatible', 'The daemon does not serve this socket.');
        clock.clearTimeout(timer);
        schedule();
        settle(connection);
        return;
      }
      receive(message);
    } catch (error) {
      // Whatever was wrong, the daemon is told nothing and the connection closes.
      end(
        ApplicationError.is(error) && error.code !== 'InvalidInput'
          ? new ApplicationError({
              code: error.code === 'Unauthorized' ? 'Unauthorized' : 'Incompatible',
              message: 'The daemon sent an invalid or unauthenticated message.',
            })
          : unavailable(),
      );
    }
  });
  const socketClosed = new Promise<void>((resolve) =>
    socket.addEventListener('close', () => {
      end(unavailable());
      resolve();
    }),
  );
  socket.addEventListener('error', () => end(unavailable()));

  const connection: DaemonSocket = {
    get health() {
      return health!;
    },
    get lastReceived() {
      return lastReceived;
    },
    request(operation, input, requestOptions) {
      return new Promise((resolve, reject) => {
        if (reason) return reject(reason);
        let decoded: unknown,
          mutation: boolean,
          capability: string,
          chunked = false,
          total = 0;
        try {
          if (isHostCommand(operation)) {
            decoded = decodeHostInput(operation, input);
            mutation = isHostMutation(operation);
            capability = chatHostCapabilities.workspace;
          } else if (isDaemonCommand(operation)) {
            decoded = decodeDaemonInput(operation, input);
            mutation = isDaemonMutation(operation);
            capability = daemonCommandCapabilities[operation];
          } else {
            const command = V.command(operation);
            decoded = V.input(command, input);
            mutation = V.isMutation(command);
            capability =
              command === 'createChat' ? chatHostCapabilities.local : chatHostCapabilities.chat;
          }
          if (!health!.capabilities.includes(capability as never))
            V.fail('Incompatible', 'The daemon does not offer this feature.');
          const bytes = Buffer.byteLength(JSON.stringify({ operation, input: decoded }));
          if (
            bytes >
            (isHostCommand(operation)
              ? socketLimits.workspaceRequestBytes
              : P.maximumChatRequestBytes)
          )
            V.fail('InvalidInput', 'Request input exceeds its transport limit.');
          // A workspace request over a frame is sent as chunks; a chat one never is.
          chunked = isHostCommand(operation) && bytes + 288 > socketLimits.frameBytes;
          total = bytes;
          if (requestOptions?.signal?.aborted) V.fail('Cancelled', 'The request was cancelled.');
        } catch (error) {
          return reject(error);
        }
        const id = String(nextId++);
        const check = (value: unknown) => {
          if (isHostCommand(operation)) return decodeHostOutput(operation, value);
          if (isDaemonCommand(operation)) {
            const output = decodeDaemonOutput(operation, value);
            const requestId = (decoded as { requestId?: string }).requestId;
            if (
              requestId !== undefined &&
              (output as { requestId?: string }).requestId !== requestId
            )
              V.fail('Incompatible', 'Daemon request identity changed.');
            return output;
          }
          return V.output(operation as ChatCommand, value, decoded as never);
        };
        // What a chunked request holds of the connection's in-flight input, until it settles.
        let charged = 0;
        const abort = () => {
          if (!requests.has(id) || mutation) return;
          requests.delete(id);
          // The daemon holds a cancelled request's input until it replies.
          if (isHostCommand(operation)) abandoned.set(id, charged);
          charged = 0;
          try {
            send({ type: 'cancel', id });
          } catch {}
          reject(
            new ApplicationError({ code: 'Cancelled', message: 'The request was cancelled.' }),
          );
        };
        requestOptions?.signal?.addEventListener('abort', abort, { once: true });
        const done = () => {
          requestOptions?.signal?.removeEventListener('abort', abort);
          release(charged);
          charged = 0;
        };
        const pending: Pending = {
          operation,
          mutation,
          resolve: (value) => {
            done();
            try {
              resolve(check(value) as never);
            } catch {
              reject(invalidReply(mutation));
            }
          },
          reject: (error) => {
            done();
            reject(error);
          },
        };
        requests.set(id, pending);
        const transmit = () => {
          try {
            if (!chunked) return send({ type: 'request', id, operation, input: decoded });
            const bytes = Buffer.from(JSON.stringify({ operation, input: decoded }));
            // Back to back, so nothing else is sent between them.
            for (let offset = 0; offset < bytes.length; offset += socketLimits.chunkBytes)
              send({
                type: 'requestChunk',
                id,
                offset,
                total: bytes.length,
                data: bytes.subarray(offset, offset + socketLimits.chunkBytes).toString('base64'),
              });
          } catch {
            requests.delete(id);
            done();
            reject(unavailable());
          }
        };
        if (!chunked) return transmit();
        void acquire(total).then(() => {
          // A request that ended while it waited sends nothing.
          if (requests.get(id) !== pending) return release(total);
          charged = total;
          transmit();
        });
      });
    },
    subscribe(kind, target, handlers, resume) {
      const subscriptionId = resume?.subscriptionId ?? P.nonce();
      const subscription: Subscription = {
        kind,
        target,
        ...(resume ? { state: resume } : {}),
        receive: handlers.receive as Subscription['receive'],
        onError: handlers.onError,
      };
      if (reason) queueMicrotask(() => handlers.onError(reason!, true));
      else {
        subscriptions.set(subscriptionId, subscription);
        try {
          send({
            type: 'subscribe',
            subscriptionId,
            kind,
            target,
            ...(resume ? { afterSequence: resume.sequence } : {}),
          });
        } catch (error) {
          end(ApplicationError.is(error) ? error : unavailable());
        }
      }
      return {
        subscriptionId,
        get state() {
          return subscription.state as never;
        },
        close() {
          if (subscriptions.get(subscriptionId) !== subscription) return;
          subscriptions.delete(subscriptionId);
          try {
            send({ type: 'unsubscribe', subscriptionId });
          } catch {}
        },
      };
    },
    closed,
    close() {
      end(unavailable('The daemon connection was closed.'));
      return socketClosed;
    },
  };
  return connected;
}
