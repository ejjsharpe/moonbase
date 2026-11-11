import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getJsonKey } from '@moonbase/contracts/common';
import type { ChatClient } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import { daemonCommandCapabilities } from '@moonbase/contracts/daemon-schema';
import {
  chatProtocolVersion,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import {
  socketLimits,
  socketPath,
  type SocketClientMessage,
  type SocketSubscriptionKind,
  type SocketSubscriptionTarget,
  type SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import { decodeSocketClientMessage } from '@moonbase/contracts/socket-schema';
import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import * as V from './validation.ts';
import {
  chunkPayload,
  deriveSocketKeys,
  openSocketMessage,
  readSealedBody,
  sealSocketMessage,
  verifySocketMessage,
  type SocketClock,
  type SocketKeys,
} from './socket-protocol.ts';
import { projectSocketDelta } from './socket-deltas.ts';
import { followChanges } from './changes.ts';
import {
  acceptWebSocketKey,
  encodeWebSocketClose,
  encodeWebSocketFrame,
  webSocketCloseCodes,
  webSocketOpcodes,
  WebSocketReader,
} from './websocket.ts';

/** What a daemon pushes to provider subscriptions, and how it counts connections. */
export type SocketSources = {
  /** Calls `listener` after any provider setup change; returns its unsubscribe. */
  subscribeProviderSetup?(listener: () => void): () => void;
  /** Called once a connection is authenticated; the function it returns, once that closes. */
  trackConnection?(): () => void;
};
export type SocketServerContext = {
  token: string;
  host: ChatHostTarget;
  health: ChatHostHealth;
  client: ChatClient;
  /** A daemon's operations; without them, provider setup subscriptions are refused. */
  daemon?: DaemonClient;
  sources: SocketSources;
  clock: SocketClock;
  /** Runs one request; resolves its reply, never rejects. */
  answer(operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
};
/** Authenticated connections open at once; the HTTP listener has its own bound. */
const maximumConnections = 32;
/**
 * Connections still waiting for their hello, bounded apart from authenticated ones so that a
 * process without the token cannot take every slot. A new one evicts the oldest, which bounds
 * how long a held handshake occupies a slot; authenticated connections are unaffected, but a
 * fast enough flood of new ones can still evict a client's before its hello arrives.
 */
const maximumHandshakes = 8;
/** A refused or closed connection's socket is destroyed this long after its close frame. */
const lingerMs = 1000;

type Update = { base: number; sequence: number; delta: unknown; bytes: number };
/** A subscription's numbered updates; it outlives its connection for `socketLimits.resumeMs`. */
type Feed = {
  id: string;
  kind: SocketSubscriptionKind;
  key: string;
  target: SocketSubscriptionTarget<SocketSubscriptionKind>;
  sequence: number;
  /** The value the latest update described. */
  sent?: SocketSubscriptionValue<SocketSubscriptionKind>;
  history: Update[];
  historyBytes: number;
  /** The source's newest value, when it has not been sent. */
  latest?: SocketSubscriptionValue<SocketSubscriptionKind>;
  /** Kept deltas a resuming client is sent first. */
  replay: Update[];
  /** Why the subscription ended, sent to its client next. */
  ended?: ReturnType<typeof P.publicError>['code'];
  session?: Session;
  close?: () => Promise<void>;
  expiry?: unknown;
};

/**
 * Serves `GET /v2/socket` upgrades on the HTTP listener: one authenticated connection per client
 * with requests, subscriptions and numbered deltas.
 */
export function createSocketServer(context: SocketServerContext) {
  const sessions = new Set<Session>(),
    handshakes = new Set<Session>(),
    /** Every live subscription by ID, attached or kept for resuming. */
    feeds = new Map<string, Feed>(),
    resumable = new Set<Feed>();
  let closed = false,
    /** Kept deltas' bytes across every feed. */
    historyBytes = 0;

  const dropHistory = (feed: Feed) => {
    historyBytes -= feed.historyBytes;
    feed.history = [];
    feed.historyBytes = 0;
  };
  const trimHistory = (feed: Feed) => {
    const oldest = feed.history.shift()!;
    feed.historyBytes -= oldest.bytes;
    historyBytes -= oldest.bytes;
  };
  /** Keeps a delta for resuming within its feed's bounds and the server's. */
  const keep = (feed: Feed, update: Update) => {
    feed.history.push(update);
    feed.historyBytes += update.bytes;
    historyBytes += update.bytes;
    while (
      feed.history.length > socketLimits.historyUpdates ||
      feed.historyBytes > socketLimits.historyBytes
    )
      trimHistory(feed);
    for (const other of feeds.values()) {
      if (historyBytes <= socketLimits.historyTotalBytes) break;
      while (other.history.length && historyBytes > socketLimits.historyTotalBytes)
        trimHistory(other);
    }
  };
  /** Stops a feed's expiry; it is no longer kept to resume. */
  const claim = (feed: Feed) => {
    if (feed.expiry !== undefined) context.clock.clearTimeout(feed.expiry);
    feed.expiry = undefined;
    resumable.delete(feed);
  };
  const forget = (feed: Feed) => {
    claim(feed);
    dropHistory(feed);
    if (feeds.get(feed.id) === feed) feeds.delete(feed.id);
  };
  /** Stops a feed's source; it is kept to resume unless it ended or the server closed. */
  const detach = (feed: Feed) => {
    feed.session = undefined;
    void feed.close?.().catch(() => {});
    feed.close = undefined;
    if (feed.ended || closed) return forget(feed);
    resumable.add(feed);
    feed.expiry = context.clock.setTimeout(() => forget(feed), socketLimits.resumeMs);
    for (const old of resumable) {
      if (resumable.size <= socketLimits.resumable) break;
      forget(old);
    }
  };

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      setTimeout(() => socket.destroy(), lingerMs).unref();
    };
    const accept = acceptWebSocketKey(request.headers['sec-websocket-key']);
    // A browser page always sends Origin; only privileged local processes may connect.
    if (request.headers.origin !== undefined) return refuse(403);
    if (
      closed ||
      request.method !== 'GET' ||
      request.url !== socketPath ||
      // Any port: through an SSH forward, Host names the client's local end of the tunnel.
      !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '') ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      request.headers['sec-websocket-version'] !== '13' ||
      !accept
    )
      return refuse(400);
    if (sessions.size >= maximumConnections) return refuse(503);
    for (const oldest of handshakes) {
      if (handshakes.size < maximumHandshakes) break;
      oldest.evict();
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nCache-Control: no-store\r\n\r\n`,
    );
    const session = new Session(socket, context, {
      feeds,
      forget,
      claim,
      detach,
      keep,
      dropHistory,
      authenticate: () => {
        if (!handshakes.delete(session) || sessions.size >= maximumConnections) return false;
        sessions.add(session);
        return true;
      },
      remove: () => void (handshakes.delete(session) || sessions.delete(session)),
    });
    handshakes.add(session);
    if (head.length) session.receive(head);
  }

  return {
    upgrade,
    async close() {
      closed = true;
      await Promise.allSettled(
        [...handshakes, ...sessions].map((session) =>
          session.shutdown(webSocketCloseCodes.goingAway, true),
        ),
      );
      for (const feed of feeds.values()) forget(feed);
    },
  };
}

type Registry = {
  feeds: Map<string, Feed>;
  /** Ends a feed for good, with its kept deltas. */
  forget(feed: Feed): void;
  /** Takes a feed kept to resume. */
  claim(feed: Feed): void;
  detach(feed: Feed): void;
  keep(feed: Feed, update: Update): void;
  dropHistory(feed: Feed): void;
  /** Counts an authenticated connection; false when there is no room for it. */
  authenticate(): boolean;
  remove(): void;
};

class Session {
  private readonly reader = new WebSocketReader(4096, true);
  private phase: 'hello' | 'open' | 'closed' = 'hello';
  private readonly challenge = P.nonce();
  private keys: SocketKeys | undefined;
  private received = 0;
  private sent = 0;
  private lastReceived: number;
  private lastSent: number;
  private timer: unknown;
  private readonly requests = new Map<string, AbortController>();
  private readonly subscriptions = new Map<string, Feed>();
  private readonly replies: Buffer[][] = [];
  private readonly ready = new Set<Feed>();
  private pumping = false;
  /** Set while the socket holds more than `outboundBytes`: reading pauses until it drains. */
  private congestion: Promise<void> | undefined;
  private drain: (() => void) | undefined;
  private untrack: (() => void) | undefined;
  private readonly socket: Duplex;
  private readonly context: SocketServerContext;
  private readonly registry: Registry;
  private readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(socket: Duplex, context: SocketServerContext, registry: Registry) {
    this.socket = socket;
    this.context = context;
    this.registry = registry;
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
    this.lastReceived = this.lastSent = context.clock.now();
    socket.on('data', (bytes: Buffer) => this.receive(bytes));
    socket.on('drain', () => this.drain?.());
    socket.on('error', () => this.end());
    socket.on('close', () => this.end());
    // The challenge is the only unauthenticated message; the hello must answer it in time.
    socket.write(
      encodeWebSocketFrame(
        webSocketOpcodes.binary,
        Buffer.from(
          JSON.stringify({
            type: 'challenge',
            protocol: chatProtocolVersion,
            challenge: this.challenge,
          }),
        ),
      ),
    );
    this.timer = context.clock.setTimeout(() => this.fail(), socketLimits.handshakeMs);
  }

  /**
   * Handles received frames until the socket is congested; frames already read wait in the
   * reader until it drains. Only the hello is accepted before authentication, and only
   * authenticated messages count as activity, so pings never keep a connection alive.
   */
  receive(bytes: Buffer) {
    if (this.phase === 'closed') return;
    try {
      for (const { opcode, payload } of this.reader.push(bytes)) {
        if ((this.phase as string) === 'closed') return;
        if (opcode === webSocketOpcodes.close) return this.shutdown(webSocketCloseCodes.normal);
        if (opcode !== webSocketOpcodes.binary && this.phase === 'hello') return this.fail();
        if (opcode === webSocketOpcodes.ping)
          this.socket.write(encodeWebSocketFrame(webSocketOpcodes.pong, payload));
        else if (opcode === webSocketOpcodes.pong) continue;
        else if (opcode !== webSocketOpcodes.binary) return this.fail();
        else if (this.phase === 'hello') this.hello(payload);
        else {
          const message = this.open(payload);
          this.lastReceived = this.context.clock.now();
          this.handle(message, payload.length);
        }
        if (this.congested()) return;
      }
    } catch {
      this.fail();
    }
  }

  /** The hello's MAC is under keys derived from its own nonce and this connection's challenge. */
  private hello(bytes: Buffer) {
    const body = readSealedBody(bytes);
    if (!body) return this.fail();
    const message = decodeSocketClientMessage(P.json(body));
    if (
      message.type !== 'hello' ||
      message.seq !== 0 ||
      !V.sameHost(message.host, this.context.host)
    )
      return this.fail();
    const keys = deriveSocketKeys(this.context.token, {
      nonce: message.nonce,
      challenge: this.challenge,
      host: this.context.host,
    });
    if (!verifySocketMessage(keys.client, bytes) || !this.registry.authenticate())
      return this.fail();
    this.keys = keys;
    this.lastReceived = this.context.clock.now();
    this.received = 1;
    this.phase = 'open';
    this.reader.maximum = socketLimits.frameBytes;
    this.context.clock.clearTimeout(this.timer);
    this.untrack = this.context.sources.trackConnection?.();
    this.send({ type: 'welcome', health: this.context.health });
    this.schedule();
  }

  /** An authenticated message is the next in sequence, or the connection closes. */
  private open(bytes: Buffer): SocketClientMessage {
    const message = decodeSocketClientMessage(openSocketMessage(this.keys!.client, bytes));
    if (message.seq !== this.received) V.fail('Unauthorized', 'Socket message is out of sequence.');
    this.received++;
    return message;
  }

  private handle(message: SocketClientMessage, bytes: number) {
    switch (message.type) {
      case 'hello':
        return this.fail();
      case 'heartbeat':
        return;
      case 'request':
        return this.request(message.id, message.operation, message.input, bytes);
      case 'cancel':
        this.requests.get(message.id)?.abort();
        return;
      case 'subscribe':
        return this.subscribe(message);
      case 'unsubscribe': {
        const feed = this.subscriptions.get(message.subscriptionId);
        if (!feed) return;
        this.subscriptions.delete(feed.id);
        this.ready.delete(feed);
        feed.ended = 'Cancelled';
        this.registry.detach(feed);
        return;
      }
    }
  }

  /** `bytes` is the request's whole frame, held to an HTTP request body's bound. */
  private request(id: string, operation: string, input: unknown, bytes: number) {
    if (this.requests.has(id)) return this.fail();
    if (bytes > P.maximumChatRequestBytes) {
      this.queueReply(id, {
        ok: false,
        error: { code: 'InvalidInput', message: 'Chat input exceeds its transport limit.' },
      });
      return;
    }
    if (this.requests.size >= socketLimits.requests) {
      this.queueReply(id, {
        ok: false,
        error: { code: 'Unavailable', message: 'Too many requests are in flight; retry.' },
      });
      return;
    }
    const controller = new AbortController();
    this.requests.set(id, controller);
    void this.context.answer(operation, input, controller.signal).then((reply) => {
      this.requests.delete(id);
      this.queueReply(id, reply);
    });
  }

  private queueReply(id: string, reply: unknown) {
    if (this.phase !== 'open') return;
    const chunks =
      chunkPayload(reply) ??
      chunkPayload({
        ok: false,
        error: P.publicError(
          new ApplicationError({ code: 'InvalidInput', message: 'Reply exceeds its limit.' }),
        ),
      })!;
    try {
      this.queue(chunks.map((chunk) => this.seal({ type: 'reply', id, ...chunk })));
    } catch {
      this.fail();
    }
  }
  /** Queues frames ahead of updates; a client that leaves too many unread is disconnected. */
  private queue(frames: Buffer[]) {
    if (this.replies.length >= socketLimits.queuedReplies) return this.fail();
    this.replies.push(frames);
    void this.pump();
  }

  private subscribe(message: Extract<SocketClientMessage, { type: 'subscribe' }>) {
    const { subscriptionId: id, kind, target } = message;
    if (this.subscriptions.has(id)) return this.fail();
    const host = 'host' in target ? target.host : (target as { host: ChatHostTarget }).host;
    const key = getJsonKey({ kind, target });
    let feed = this.registry.feeds.get(id);
    if (feed && feed.key !== key) return this.fail();
    const refuse = (code: 'Unauthorized' | 'Unavailable') =>
      this.queue([this.seal({ type: 'update', subscriptionId: id, kind: 'error', code })]);
    if (!V.sameHost(host, this.context.host)) return refuse('Unauthorized');
    if (this.subscriptions.size >= socketLimits.subscriptions) return refuse('Unavailable');
    if (feed) {
      // A client that reconnected before its old connection closed takes the subscription over.
      feed.session?.release(feed);
      // One that ended before its error was sent starts again.
      if (feed.ended) {
        this.registry.forget(feed);
        feed = undefined;
      } else this.registry.claim(feed);
    }
    if (feed) {
      const after = message.afterSequence,
        start = feed.history.findIndex((update) => update.base === after);
      // A chat list's source starts again without the chats that changed past its first page
      // meanwhile, so it resumes with a fresh snapshot rather than deltas.
      if (
        after === undefined ||
        (after !== feed.sequence && start < 0) ||
        feed.kind === 'chatList'
      ) {
        feed.sent = undefined;
        feed.replay = [];
      } else feed.replay = start < 0 ? [] : feed.history.slice(start);
    } else
      feed = {
        id,
        kind,
        key,
        target,
        sequence: 0,
        history: [],
        historyBytes: 0,
        replay: [],
      };
    feed.latest = undefined;
    feed.session = this;
    this.registry.feeds.set(id, feed);
    this.subscriptions.set(id, feed);
    if (feed.replay.length) this.ready.add(feed);
    this.watch(feed);
    void this.pump();
  }

  /** Starts a feed's source; each value it gives replaces the one waiting to be sent. */
  private watch(feed: Feed) {
    const receive = (value: SocketSubscriptionValue<SocketSubscriptionKind>) => {
      if (feed.session !== this || feed.ended) return;
      feed.latest = value;
      this.ready.add(feed);
      void this.pump();
    };
    const end = (error: unknown) => {
      if (feed.session !== this || feed.ended) return;
      const { code } = P.publicError(error);
      feed.ended = code === 'Uncertain' ? 'Unavailable' : code;
      this.ready.add(feed);
      void this.pump();
    };
    try {
      if (feed.kind === 'chat') {
        feed.close = this.context.client.watch(
          { target: feed.target as SocketSubscriptionTarget<'chat'> },
          receive,
          end,
        );
        return;
      }
      if (feed.kind === 'chatList') {
        feed.close = this.context.client.watchChatList(
          { session: feed.target as SocketSubscriptionTarget<'chatList'> },
          ({ list, changed, dropped }) => receive({ list, changed, dropped }),
          end,
        );
        return;
      }
      const daemon = this.context.daemon,
        subscribe = this.context.sources.subscribeProviderSetup;
      // Only what health advertises is served, as for daemon requests.
      if (
        !daemon ||
        !subscribe ||
        !this.context.health.capabilities.includes(daemonCommandCapabilities.getProviders)
      )
        return V.fail('Incompatible', 'This host does not serve provider setup.');
      // A provider read follows each change, one at a time; changes during a read start one more.
      const target = feed.target as SocketSubscriptionTarget<'providerSetup'>;
      const stop = followChanges(
        subscribe,
        () => daemon.command('getProviders', { host: target.host, ownerId: target.ownerId }),
        ({ state }) => receive(state),
        end,
      );
      feed.close = async () => stop();
    } catch (error) {
      end(error);
    }
  }

  /**
   * Releases a subscription another connection took over, without ending it; this connection's
   * client learns it ended with `Conflict`.
   */
  release(feed: Feed) {
    if (this.subscriptions.get(feed.id) !== feed) return;
    this.subscriptions.delete(feed.id);
    this.ready.delete(feed);
    feed.session = undefined;
    void feed.close?.().catch(() => {});
    feed.close = undefined;
    if (this.phase === 'open')
      this.queue([
        this.seal({ type: 'update', subscriptionId: feed.id, kind: 'error', code: 'Conflict' }),
      ]);
  }
  /** Closes a connection still waiting for its hello, to make room for a newer one. */
  evict() {
    this.fail();
  }

  /** The frames of a feed's next update: kept deltas first, then a delta or a fresh snapshot. */
  private nextUpdate(feed: Feed): Buffer[] {
    const update = { type: 'update', subscriptionId: feed.id } as const;
    if (feed.ended) {
      this.subscriptions.delete(feed.id);
      this.registry.detach(feed);
      return [this.seal({ ...update, kind: 'error', code: feed.ended })];
    }
    const frames = feed.replay.map((kept) =>
      this.seal({
        ...update,
        kind: 'delta',
        sequence: kept.sequence,
        base: kept.base,
        delta: kept.delta,
      }),
    );
    feed.replay = [];
    const value = feed.latest;
    if (value === undefined) return frames;
    feed.latest = undefined;
    if (feed.sent !== undefined) {
      const delta = projectSocketDelta(feed.kind, feed.sent, value);
      if (delta === null) return frames;
      const bytes = delta ? Buffer.byteLength(JSON.stringify(delta)) : Infinity;
      if (delta && bytes <= socketLimits.deltaBytes) {
        const kept = { base: feed.sequence, sequence: ++feed.sequence, delta, bytes };
        this.registry.keep(feed, kept);
        feed.sent = value;
        frames.push(this.seal({ ...update, kind: 'delta', ...kept, bytes: undefined }));
        return frames;
      }
    }
    // A fresh snapshot resets the subscription: deltas before it no longer resume it.
    const chunks = chunkPayload(value);
    if (!chunks) {
      feed.ended = 'InvalidInput';
      return [...frames, ...this.nextUpdate(feed)];
    }
    feed.sequence++;
    this.registry.dropHistory(feed);
    feed.sent = value;
    for (const chunk of chunks)
      frames.push(this.seal({ ...update, kind: 'snapshot', sequence: feed.sequence, ...chunk }));
    return frames;
  }

  /**
   * Writes replies before updates and updates round robin, so streaming never delays Send or
   * Stop; while the socket holds `outboundBytes`, it waits and updates coalesce.
   */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.phase === 'open') {
        let frames = this.replies.shift();
        if (!frames) {
          const feed = this.ready.values().next().value;
          if (!feed) break;
          this.ready.delete(feed);
          frames = this.nextUpdate(feed);
        }
        for (const frame of frames) this.write(frame);
        const congestion = this.congested();
        if (congestion) await congestion;
      }
    } catch {
      this.fail();
    } finally {
      this.pumping = false;
    }
  }

  /**
   * While the socket holds more than `outboundBytes`, reading pauses so a client that never
   * reads cannot make the daemon buffer more, and one that reads nothing for `drainMs` is
   * disconnected. Resolves once it drains or the connection closes.
   */
  private congested() {
    if (
      this.phase === 'closed' ||
      this.congestion ||
      this.socket.writableLength <= socketLimits.outboundBytes
    )
      return this.congestion;
    this.socket.pause();
    this.congestion = new Promise<void>((resolve) => {
      const timer = this.context.clock.setTimeout(() => this.fail(), socketLimits.drainMs);
      this.drain = () => {
        this.context.clock.clearTimeout(timer);
        this.drain = this.congestion = undefined;
        resolve();
        if (this.phase === 'closed') return;
        this.socket.resume();
        this.receive(Buffer.alloc(0));
      };
    });
    return this.congestion;
  }

  private seal(message: Record<string, unknown>) {
    const value = Object.fromEntries(
      Object.entries({ ...message, seq: this.sent++ }).filter(([, item]) => item !== undefined),
    );
    return sealSocketMessage(this.keys!.server, value);
  }
  private send(message: Record<string, unknown>) {
    this.write(this.seal(message));
  }
  private write(frame: Buffer) {
    this.lastSent = this.context.clock.now();
    this.socket.write(encodeWebSocketFrame(webSocketOpcodes.binary, frame));
  }

  /** Heartbeats fill quiet intervals; a client silent past `idleMs` is disconnected. */
  private schedule() {
    const now = this.context.clock.now(),
      due = Math.min(
        this.lastSent + socketLimits.heartbeatMs,
        this.lastReceived + socketLimits.idleMs,
      );
    this.timer = this.context.clock.setTimeout(
      () => {
        if (this.phase !== 'open') return;
        const time = this.context.clock.now();
        if (time - this.lastReceived >= socketLimits.idleMs) return this.fail();
        if (time - this.lastSent >= socketLimits.heartbeatMs && !this.pumping)
          this.send({ type: 'heartbeat' });
        this.schedule();
      },
      Math.max(0, due - now),
    );
  }

  /** Any refusal closes with one code and no reason, so nothing says what was wrong. */
  private fail() {
    void this.shutdown(webSocketCloseCodes.policy);
  }
  /**
   * Sends a close frame and stops reading. The socket is destroyed once the frame is written
   * when `immediate`, as when the daemon shuts down, or else after a moment for the client to
   * read it.
   */
  shutdown(code: number, immediate = false) {
    if (this.phase !== 'closed') {
      // Nothing more is read from a connection that is closing.
      this.socket.pause();
      this.socket.end(encodeWebSocketClose(code), () => {
        if (immediate) this.socket.destroy();
      });
      setTimeout(() => this.socket.destroy(), lingerMs).unref();
      this.end();
    }
    return this.finished;
  }
  /**
   * Cleans up once: reads still running are cancelled, while mutations run to completion so a
   * retry with the original request ID finds their outcome; subscriptions are kept to resume.
   */
  private end() {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.context.clock.clearTimeout(this.timer);
    this.drain?.();
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    for (const feed of this.subscriptions.values()) this.registry.detach(feed);
    this.subscriptions.clear();
    this.ready.clear();
    this.replies.length = 0;
    this.untrack?.();
    this.untrack = undefined;
    this.registry.remove();
    if (this.socket.destroyed) this.resolveFinished();
    else this.socket.once('close', () => this.resolveFinished());
  }
}
