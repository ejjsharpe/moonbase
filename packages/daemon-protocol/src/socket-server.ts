import { getJsonKey } from '@moonbase/contracts/common';
import type { ChatClient } from '@moonbase/contracts/chat';
import { isChatCommand } from '@moonbase/contracts/chat-schema';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import { daemonCommandCapabilities } from '@moonbase/contracts/daemon-schema';
import {
  chatHostCapabilities,
  chatProtocolVersion,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import type { WorkspaceHostClient } from '@moonbase/contracts/workspace-host';
import { isHostCommand, isHostMutation } from '@moonbase/contracts/workspace-host-schema';
import {
  socketLimits,
  socketPath,
  type SocketClientMessage,
  type SocketSubscriptionKind,
  type SocketSubscriptionTarget,
  type SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import {
  decodeSocketChunkedRequest,
  decodeSocketClientMessage,
} from '@moonbase/contracts/socket-schema';
import { ApplicationError } from '@moonbase/contracts/workspace';
import * as P from './protocol.ts';
import { isCancellableChatRead, isSameChatHost } from '@moonbase/contracts/chat-validation';
import { fail } from '@moonbase/contracts/errors';
import {
  chunkPayload,
  payloadChunks,
  deriveSocketKeys,
  openSocketMessage,
  PayloadAssembler,
  readSealedBody,
  sealSocketMessage,
  verifySocketMessage,
  type PayloadChunks,
  type SocketClock,
  type SocketKeys,
} from './socket-protocol.ts';
import { projectSocketDelta } from './socket-deltas.ts';
import { followChanges } from '@moonbase/effect/changes';
import type { BunServer, BunServeOptions, BunWebSocket } from './bun-server.ts';

/** What Bun keeps with each upgraded connection. */
export type SocketData = { session?: Session };
/** Close codes the daemon sends: going away on shutdown, policy violation for any refusal. */
const closeCodes = { goingAway: 1001, policy: 1008 };
/** Before its hello, a connection may send only a message this small. */
const maximumHelloBytes = 4096;
/** Bun's own bound on a socket's buffered output; the session stops writing far below it. */
const backpressureLimit = 1024 * 1024 * 1024;
/** A `Sec-WebSocket-Key` is the base64 of 16 bytes. */
const isWebSocketKey = (key: string | null) =>
  key !== null && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16;

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
  /** The file host; without it, workspace subscriptions are refused. */
  workspace?: WorkspaceHostClient;
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
/** A closing connection is cut this long after its close frame if the client never answers. */
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
 * Serves `GET /v2/socket` upgrades on the daemon's `Bun.serve` listener: one authenticated
 * connection per client with requests, subscriptions and numbered deltas. Bun does the framing;
 * this decides which upgrades it accepts and runs each connection's session.
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
  /**
   * Stops a feed's source; it is kept to resume unless it ended, the server closed or it is a
   * workspace feed, which always resumes from a fresh snapshot.
   */
  const detach = (feed: Feed) => {
    feed.session = undefined;
    void feed.close?.().catch(() => {});
    feed.close = undefined;
    if (feed.ended || closed || feed.kind === 'workspace') return forget(feed);
    resumable.add(feed);
    feed.expiry = context.clock.setTimeout(() => forget(feed), socketLimits.resumeMs);
    for (const old of resumable) {
      if (resumable.size <= socketLimits.resumable) break;
      forget(old);
    }
  };

  const registry = (session: () => Session): Registry => ({
    feeds,
    forget,
    claim,
    detach,
    keep,
    dropHistory,
    authenticate: () => {
      if (!handshakes.delete(session()) || sessions.size >= maximumConnections) return false;
      sessions.add(session());
      return true;
    },
    remove: () => void (handshakes.delete(session()) || sessions.delete(session())),
  });

  /**
   * Upgrades a request for the socket, or answers the status it is refused with. Every check is
   * made before Bun upgrades it.
   */
  function upgrade(request: Request, server: BunServer<SocketData>): Response | undefined {
    const refuse = (status: number) =>
      new Response(null, { status, headers: { Connection: 'close' } });
    const headers = request.headers;
    // A browser page always sends Origin; only privileged local processes may connect.
    if (headers.get('origin') !== null) return refuse(403);
    // Any port: through an SSH forward, Host names the client's local end of the tunnel. Bun
    // builds the request's URL from Host, so it is checked before the URL is read.
    if (!/^127\.0\.0\.1:\d+$/.test(headers.get('host') ?? '')) return refuse(400);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return refuse(400);
    }
    if (
      closed ||
      request.method !== 'GET' ||
      url.pathname !== socketPath ||
      url.search !== '' ||
      headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      headers.get('sec-websocket-version') !== '13' ||
      !isWebSocketKey(headers.get('sec-websocket-key'))
    )
      return refuse(400);
    if (sessions.size >= maximumConnections) return refuse(503);
    if (!server.upgrade(request, { data: {}, headers: { 'Cache-Control': 'no-store' } }))
      return refuse(400);
    return undefined;
  }

  /** Bun's WebSocket options: its limits, and handlers that pass each event to its session. */
  const websocket: BunServeOptions<SocketData>['websocket'] = {
    // Bun refuses a larger message; before its hello a session takes far less.
    maxPayloadLength: socketLimits.frameBytes,
    // The session's heartbeat and idle limit decide when a socket is quiet.
    idleTimeout: 0,
    sendPings: false,
    backpressureLimit,
    closeOnBackpressureLimit: false,
    perMessageDeflate: false,
    open(socket) {
      try {
        if (closed) return socket.terminate();
        for (const oldest of handshakes) {
          if (handshakes.size < maximumHandshakes) break;
          oldest.evict();
        }
        const session: Session = new Session(
          socket,
          context,
          registry(() => session),
        );
        socket.data.session = session;
        handshakes.add(session);
      } catch {
        socket.terminate();
      }
    },
    message: (socket, message) => guard(socket, (session) => session.receive(message)),
    ping: (socket) => guard(socket, (session) => session.ping()),
    drain: (socket) => guard(socket, (session) => session.drained()),
    close: (socket) => guard(socket, (session) => session.closed()),
  };
  /** Runs one event on its session; a failure cuts the connection and is never Bun's to report. */
  function guard(socket: BunWebSocket<SocketData>, run: (session: Session) => void) {
    const session = socket.data.session;
    if (!session) return;
    try {
      run(session);
    } catch {
      try {
        socket.terminate();
      } catch {}
    }
  }

  return {
    upgrade,
    websocket,
    async close() {
      closed = true;
      await Promise.allSettled(
        [...handshakes, ...sessions].map((session) => session.shutdown(closeCodes.goingAway)),
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

/**
 * Whether a request's signal stops it, so a cancel ends it at once: workspace and cancellable chat
 * reads. Mutations and other reads run to completion and are answered.
 */
const isCancellable = (operation: string) =>
  isHostCommand(operation)
    ? !isHostMutation(operation)
    : isChatCommand(operation) && isCancellableChatRead(operation);
/** A running request: what cancels it, and the chunked input it holds of `chunkedBytes`. */
type Running = { controller: AbortController; cancellable: boolean; charged: number };
/** An encoded workspace reply waiting to be written, and its next chunk. */
type WorkspaceReply = { id: string; cancellable: boolean; chunks: PayloadChunks; next: number };
const refusal = (code: 'Unavailable' | 'InvalidInput' | 'Cancelled', message: string) => ({
  ok: false,
  error: { code, message },
});

class Session {
  private phase: 'hello' | 'open' | 'closed' = 'hello';
  private readonly challenge = P.nonce();
  private keys: SocketKeys | undefined;
  private received = 0;
  private sent = 0;
  private lastReceived: number;
  private lastSent: number;
  private timer: unknown;
  /** Requests running; one leaves as soon as its reply is queued or it is cancelled. */
  private readonly requests = new Map<string, Running>();
  private readonly subscriptions = new Map<string, Feed>();
  /** Chat and daemon replies and other small messages, sealed only as they are written. */
  private readonly replies: (() => Buffer[])[] = [];
  /** Workspace replies in order; only the head is written, a chunk at a time. */
  private readonly workspaceReplies: WorkspaceReply[] = [];
  private workspaceReplyBytes = 0;
  private readonly ready = new Set<Feed>();
  /** The chunked request being received, if any, and the input bytes chunked requests hold. */
  private readonly incoming = new PayloadAssembler();
  private chunkedBytes = 0;
  private pumping = false;
  /** Set while the socket holds more than `outboundBytes`: reading pauses until it drains. */
  private congestion: Promise<void> | undefined;
  private drain: (() => void) | undefined;
  private untrack: (() => void) | undefined;
  /** Set once Bun reports the connection closed. */
  private socketClosed = false;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private readonly socket: BunWebSocket<SocketData>;
  private readonly context: SocketServerContext;
  private readonly registry: Registry;
  private readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(socket: BunWebSocket<SocketData>, context: SocketServerContext, registry: Registry) {
    this.socket = socket;
    this.context = context;
    this.registry = registry;
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
    this.lastReceived = this.lastSent = context.clock.now();
    // The challenge is the only unauthenticated message; the hello must answer it in time.
    socket.sendBinary(
      Buffer.from(
        JSON.stringify({
          type: 'challenge',
          protocol: chatProtocolVersion,
          challenge: this.challenge,
        }),
      ),
    );
    this.timer = context.clock.setTimeout(() => this.fail(), socketLimits.handshakeMs);
  }

  /**
   * Handles one received message. Only a small binary hello is accepted before authentication,
   * and only authenticated messages count as activity, so pings never keep a connection alive.
   */
  receive(message: string | Uint8Array) {
    if (this.phase === 'closed') return;
    try {
      if (typeof message === 'string') return this.fail();
      const payload = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
      if (this.phase === 'hello')
        return payload.length > maximumHelloBytes ? this.fail() : this.hello(payload);
      const opened = this.open(payload);
      this.lastReceived = this.context.clock.now();
      this.handle(opened, payload.length);
      void this.congested();
    } catch {
      this.fail();
    }
  }
  /** Bun answered a ping; one before the hello is refused, and its answers count as output. */
  ping() {
    if (this.phase === 'hello') return this.fail();
    void this.congested();
  }
  /** Bun wrote out what the socket held. */
  drained() {
    this.drain?.();
  }
  /** Bun closed the connection, after a close frame or a failure. */
  closed() {
    this.socketClosed = true;
    clearTimeout(this.linger);
    this.end();
    this.resolveFinished();
  }

  /** The hello's MAC is under keys derived from its own nonce and this connection's challenge. */
  private hello(bytes: Buffer) {
    const body = readSealedBody(bytes);
    if (!body) return this.fail();
    const message = decodeSocketClientMessage(P.json(body));
    if (
      message.type !== 'hello' ||
      message.seq !== 0 ||
      !isSameChatHost(message.host, this.context.host)
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
    this.context.clock.clearTimeout(this.timer);
    this.untrack = this.context.sources.trackConnection?.();
    this.send({ type: 'welcome', health: this.context.health });
    this.schedule();
  }

  /** An authenticated message is the next in sequence, or the connection closes. */
  private open(bytes: Buffer): SocketClientMessage {
    const message = decodeSocketClientMessage(openSocketMessage(this.keys!.client, bytes));
    if (message.seq !== this.received) fail('Unauthorized', 'Socket message is out of sequence.');
    this.received++;
    return message;
  }

  private handle(message: SocketClientMessage, bytes: number) {
    // Nothing may come between one request's chunks.
    if (this.incoming.partial && message.type !== 'requestChunk') return this.fail();
    switch (message.type) {
      case 'hello':
        return this.fail();
      case 'heartbeat':
        return;
      case 'request':
        return this.request(message.id, message.operation, message.input, bytes, 0);
      case 'requestChunk':
        return this.requestChunk(message);
      case 'cancel':
        return this.cancel(message.id);
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

  /**
   * One chunk of a workspace request. The first declares the whole request's size: one that would
   * take the chunked input running past `workspaceInFlightBytes` is still read and checked, but
   * discarded and refused `Unavailable`. Any gap, overlap, other message, excess or chunked chat
   * request closes the connection.
   */
  private requestChunk(message: Extract<SocketClientMessage, { type: 'requestChunk' }>) {
    if (!this.context.health.capabilities.includes(chatHostCapabilities.workspace))
      return this.fail();
    let keep = true;
    if (!this.incoming.partial) {
      if (this.requests.has(message.id)) return this.fail();
      keep = this.chunkedBytes + message.total <= socketLimits.workspaceInFlightBytes;
      if (keep) this.chunkedBytes += message.total;
    }
    const done = this.incoming.push(message.id, message, socketLimits.workspaceRequestBytes, keep);
    if (!done) return;
    if (!('value' in done))
      return this.queueReply(
        message.id,
        refusal('Unavailable', 'Too much request input is in flight; retry.'),
      );
    const { operation, input } = decodeSocketChunkedRequest(done.value);
    if (!isHostCommand(operation)) return this.fail();
    this.request(message.id, operation, input, message.total, message.total);
  }

  /**
   * `bytes` is the request's whole frame, or all its chunks'; `charged` is what it holds of
   * `chunkedBytes` while it runs. Past `requests` running, or `workspaceQueuedBytes` of workspace
   * replies unwritten for a workspace request, it is refused `Unavailable` before it runs.
   */
  private request(id: string, operation: string, input: unknown, bytes: number, charged = 0) {
    if (this.requests.has(id)) return this.fail();
    const workspace = isHostCommand(operation);
    const refuse = (reply: unknown) => {
      this.chunkedBytes -= charged;
      this.queueReply(id, reply);
    };
    if (!workspace && bytes > P.maximumChatRequestBytes)
      return refuse(refusal('InvalidInput', 'Chat input exceeds its transport limit.'));
    if (
      this.requests.size >= socketLimits.requests ||
      (workspace && this.workspaceReplyBytes >= socketLimits.workspaceQueuedBytes)
    )
      return refuse(refusal('Unavailable', 'Too many requests are in flight; retry.'));
    const running: Running = {
      controller: new AbortController(),
      cancellable: isCancellable(operation),
      charged,
    };
    this.requests.set(id, running);
    void this.context.answer(operation, input, running.controller.signal).then((reply) => {
      // A cancelled request was answered already, and a closed connection answers nothing.
      if (this.requests.get(id) !== running) return;
      this.settle(id, running);
      this.queueReply(id, reply, operation);
    });
  }
  private settle(id: string, running: Running) {
    this.requests.delete(id);
    this.chunkedBytes -= running.charged;
  }
  /**
   * Answers a cancel: a cancellable request still running is aborted and its place freed at once,
   * and one whose reply is queued but not yet started has it dropped; either is answered
   * `Cancelled`. Anything else is answered as usual.
   */
  private cancel(id: string) {
    const running = this.requests.get(id);
    if (running) {
      if (!running.cancellable) return;
      running.controller.abort();
      this.settle(id, running);
    } else {
      const index = this.workspaceReplies.findIndex(
        (reply) => reply.id === id && reply.cancellable && reply.next === 0,
      );
      if (index < 0) return;
      this.workspaceReplyBytes -= this.workspaceReplies[index]!.chunks.bytes;
      this.workspaceReplies.splice(index, 1);
    }
    this.queueReply(id, refusal('Cancelled', 'The request was cancelled.'));
  }

  /**
   * Encodes a reply once. A workspace reply, up to `workspaceReplyBytes`, joins the workspace
   * replies; any other is written whole ahead of updates. One over its bound is replaced by a
   * refusal, or by `Uncertain` for a workspace mutation, which applied.
   */
  private queueReply(id: string, reply: unknown, operation = '') {
    if (this.phase !== 'open') return;
    const workspace = isHostCommand(operation);
    const limit = workspace ? socketLimits.workspaceReplyBytes : socketLimits.payloadBytes;
    const chunks =
      payloadChunks(reply, limit) ??
      payloadChunks(
        {
          ok: false,
          error: P.publicError(
            new ApplicationError(
              workspace && isHostMutation(operation)
                ? { code: 'Uncertain', message: 'The reply exceeds its limit; the change applied.' }
                : { code: 'InvalidInput', message: 'Reply exceeds its limit.' },
            ),
          ),
        },
        limit,
      )!;
    if (!workspace)
      return this.queue(() =>
        Array.from({ length: chunks.count }, (_, index) =>
          this.seal({ type: 'reply', id, ...chunks.chunk(index) }),
        ),
      );
    this.workspaceReplies.push({ id, cancellable: !isHostMutation(operation), chunks, next: 0 });
    this.workspaceReplyBytes += chunks.bytes;
    void this.pump();
  }
  /** Queues frames ahead of updates; a client that leaves too many unread is disconnected. */
  private queue(frames: () => Buffer[]) {
    if (this.replies.length >= socketLimits.queuedReplies) return this.fail();
    this.replies.push(frames);
    void this.pump();
  }

  private subscribe(message: Extract<SocketClientMessage, { type: 'subscribe' }>) {
    const { subscriptionId: id, kind, target } = message;
    if (this.subscriptions.has(id)) return this.fail();
    const key = getJsonKey({ kind, target });
    let feed = this.registry.feeds.get(id);
    if (feed && feed.key !== key) return this.fail();
    const refuse = (code: 'Unauthorized' | 'Unavailable') =>
      this.queue(() => [this.seal({ type: 'update', subscriptionId: id, kind: 'error', code })]);
    // A workspace target names its checkout's host; the others name a chat host.
    const own =
      kind === 'workspace'
        ? (target as SocketSubscriptionTarget<'workspace'>).checkout.hostId ===
          this.context.host.hostId
        : isSameChatHost((target as { host: ChatHostTarget }).host, this.context.host);
    if (!own) return refuse('Unauthorized');
    // Workspace subscriptions have a limit of their own, so open projects don't crowd out chats.
    const workspace = kind === 'workspace',
      held = [...this.subscriptions.values()].filter(
        (each) => (each.kind === 'workspace') === workspace,
      ).length;
    if (held >= (workspace ? socketLimits.workspaceSubscriptions : socketLimits.subscriptions))
      return refuse('Unavailable');
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
      // meanwhile, and a workspace's without the changes it missed, so both resume with a fresh
      // snapshot (which a client answers by reading again) rather than deltas.
      if (
        after === undefined ||
        (after !== feed.sequence && start < 0) ||
        feed.kind === 'chatList' ||
        feed.kind === 'workspace'
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
      if (feed.kind === 'workspace') {
        const workspace = this.context.workspace;
        if (
          !workspace ||
          !this.context.health.capabilities.includes(chatHostCapabilities.workspace)
        )
          return fail('Incompatible', 'This host does not serve the workspace.');
        feed.close = workspace.watch(
          feed.target as SocketSubscriptionTarget<'workspace'>,
          receive,
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
        return fail('Incompatible', 'This host does not serve provider setup.');
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
      this.queue(() => [
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
   * Writes chat and daemon replies first, then one chunk of the first workspace reply and one
   * pending update in turn, so streaming never delays Send or Stop and a large read never stalls
   * chat streaming (every write also counts as the heartbeat's activity). Workspace replies go
   * out in order. While the socket holds `outboundBytes`, it waits and updates coalesce.
   */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.phase === 'open') {
        const reply = this.replies.shift();
        if (reply) for (const frame of reply()) this.write(frame);
        else {
          const head = this.workspaceReplies[0];
          if (head) {
            this.write(
              this.seal({ type: 'reply', id: head.id, ...head.chunks.chunk(head.next++) }),
            );
            if (head.next >= head.chunks.count) {
              this.workspaceReplies.shift();
              this.workspaceReplyBytes -= head.chunks.bytes;
            }
          }
          const feed = this.ready.values().next().value;
          if (feed) {
            this.ready.delete(feed);
            for (const frame of this.nextUpdate(feed)) this.write(frame);
          } else if (!head) break;
        }
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
      this.socket.getBufferedAmount() <= socketLimits.outboundBytes
    )
      return this.congestion;
    this.socket.pause();
    this.congestion = new Promise<void>((resolve) => {
      const timer = this.context.clock.setTimeout(() => this.fail(), socketLimits.drainMs);
      this.drain = () => {
        this.context.clock.clearTimeout(timer);
        this.drain = undefined;
        const proceed = () => {
          this.congestion = undefined;
          resolve();
        };
        if (this.phase === 'closed') return proceed();
        // Writing resumes a turn after reading does, so what the client sent while the daemon
        // was not reading (a cancel, say) is handled first.
        this.socket.resume();
        setTimeout(proceed, 0);
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
    this.socket.sendBinary(frame);
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
    void this.shutdown(closeCodes.policy);
  }
  /**
   * Sends a close frame with `code` and no reason, and stops reading. A client that never answers
   * it is cut off after `lingerMs`.
   */
  shutdown(code: number) {
    if (this.phase !== 'closed') {
      // Nothing more is read from a connection that is closing.
      this.socket.pause();
      this.socket.close(code);
      if (!this.socketClosed) {
        this.linger = setTimeout(() => this.socket.terminate(), lingerMs);
        this.linger.unref?.();
      }
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
    for (const { controller } of this.requests.values()) controller.abort();
    this.requests.clear();
    for (const feed of this.subscriptions.values()) this.registry.detach(feed);
    this.subscriptions.clear();
    this.ready.clear();
    this.replies.length = 0;
    this.workspaceReplies.length = 0;
    this.untrack?.();
    this.untrack = undefined;
    this.registry.remove();
    if (this.socketClosed) this.resolveFinished();
  }
}
