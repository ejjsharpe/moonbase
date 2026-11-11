import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Scope, type ManagedRuntime } from 'effect';
import { GenerationTask, createRegistry, defineExtension, hook } from '@earendil-works/pi-durable';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatClient, ChatSnapshot } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import type { ProviderState } from '@moonbase/contracts/providers';
import { socketLimits, socketPath } from '@moonbase/contracts/socket';
import { ApplicationError } from '@moonbase/contracts/errors';
import { LocalPiControl } from '../src/index.ts';
import { localDaemonCapabilities, serveChat, type SocketSources } from '../src/server.ts';
import { connectDaemonSocket } from '../src/socket-client.ts';
import {
  deriveSocketKeys,
  openSocketMessage,
  PayloadAssembler,
  sealSocketMessage,
  type SocketClock,
  type SocketKeys,
} from '../src/socket-protocol.ts';
import { encodeWebSocketFrame, WebSocketReader } from '../src/websocket.ts';
import * as P from '../src/protocol.ts';
import { fixture as runtimeFixture, until } from './runtime-fixture.ts';

const host = { hostId: 'socket-host', storeId: 'socket-store' };
const session = { host, actorId: 'owner' };
const target = { ...session, conversationId: 'A' };
const providers: ProviderState = { providers: [], flow: null };

/** Time that moves only when a test advances it. */
function manualClock() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      timers.set(++next, { at: now + ms, run });
      return next;
    },
    clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at))
        if (timer.at <= now && timers.delete(handle)) timer.run();
    },
  } satisfies SocketClock & { advance(ms: number): void };
}
/** A chat whose run shows the end of `text`, after `entries` long entries that `seed` varies. */
const snapshotOf = (text: string | null, entries = 0, seed = ''): ChatSnapshot => ({
  conversation: {
    target,
    title: 'A',
    createdAt: '2026-11-11T00:00:00Z',
    cwd: '/controlled',
    model: 'faux',
  },
  entries: Array.from({ length: entries }, (_, index) => ({
    id: `e${index}`,
    role: 'assistant' as const,
    text: `${seed}:${index}:`.padEnd(4000, 'x'),
    truncated: true,
    transcript: {
      source: { kind: 'entry' as const, target, entryId: `e${index}` },
      parts: [],
      nextCursor: null,
      thinking: 'none' as const,
    },
  })),
  olderCursor: null,
  run:
    text === null
      ? null
      : {
          stop: { target, submissionId: 's', taskId: 't' },
          state: 'running',
          text: text.slice(-64),
          truncated: text.length > 64,
        },
  state: text === null ? 'idle' : 'running',
  transcriptBoundary: null,
});

/** A chat client whose watches and commands the test drives. */
function controlledClient() {
  const watches = new Set<(snapshot: ChatSnapshot) => void>(),
    ends = new Map<(snapshot: ChatSnapshot) => void, (error: ApplicationError) => void>(),
    calls: string[] = [];
  let current = snapshotOf('');
  let closes = 0;
  const handlers: Partial<
    Record<string, (input: never, signal?: AbortSignal) => Promise<unknown>>
  > = {};
  const client: ChatClient = {
    command: async (operation, input, options) => {
      calls.push(operation);
      if (operation === 'getChatHost') return { ...session, mode: 'local' } as never;
      const handler = handlers[operation];
      if (handler) return (await handler(input as never, options?.signal)) as never;
      if (operation === 'getChat') return current as never;
      if (operation === 'listChats') return { conversations: [], nextCursor: null } as never;
      throw new ApplicationError({ code: 'Unavailable', message: 'Unexpected command.' });
    },
    watch: (_input, receive, onError) => {
      watches.add(receive);
      ends.set(receive, onError);
      queueMicrotask(() => watches.has(receive) && receive(current));
      return async () => {
        closes++;
        watches.delete(receive);
        ends.delete(receive);
      };
    },
  };
  return {
    client,
    calls,
    handlers,
    get closes() {
      return closes;
    },
    get watching() {
      return watches.size;
    },
    publish(snapshot: ChatSnapshot) {
      current = snapshot;
      for (const receive of watches) receive(snapshot);
    },
    /** Ends every open watch with `error`. */
    end(error: ApplicationError) {
      for (const [receive, onError] of ends) {
        watches.delete(receive);
        ends.delete(receive);
        onError(error);
      }
    },
  };
}
const daemonClient = (state = () => providers): DaemonClient => ({
  command: async (operation) => {
    if (operation === 'getProviders') return { state: state() } as never;
    throw new ApplicationError({ code: 'Unavailable', message: 'Unexpected daemon command.' });
  },
});
const emitter = () => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: () => listeners.forEach((listener) => listener()),
  };
};

async function serve(
  t: TestContext,
  client: ChatClient,
  options: { daemon?: DaemonClient; sources?: Partial<SocketSources>; clock?: SocketClock } = {},
) {
  const token = P.nonce(),
    scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    serveChat(
      { host, token, port: 0 },
      client,
      options.daemon ?? daemonClient(),
      localDaemonCapabilities,
      {
        sources: {
          subscribeChatList: () => () => {},
          subscribeProviderSetup: () => () => {},
          ...options.sources,
        },
        ...(options.clock ? { clock: options.clock } : {}),
      },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const port = Number(new URL(server.origin).port);
  return { token, port, endpoint: { origin: server.origin, token, expected: host } };
}
async function open(
  t: TestContext,
  endpoint: { origin: string; token: string; expected: typeof host },
  clock?: SocketClock,
) {
  const socket = await connectDaemonSocket(endpoint, clock ? { clock } : {});
  t.after(() => socket.close());
  return socket;
}

/** A WebSocket client on a bare TCP socket, for frames no conforming client would send. */
async function rawSocket(port: number, headers: Record<string, string> = {}) {
  const socket = connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const reader = new WebSocketReader(1 << 30, false),
    messages: ({ opcode: number; payload: Buffer } | 'closed')[] = [];
  let head = Buffer.alloc(0),
    status: string | undefined;
  let wake: (() => void) | undefined;
  socket.on('data', (bytes: Buffer) => {
    if (status === undefined) {
      head = Buffer.concat([head, bytes]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      status = head.subarray(0, head.indexOf('\r\n')).toString();
      bytes = head.subarray(end + 4);
    }
    for (const message of reader.push(bytes)) messages.push(message);
    wake?.();
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    messages.push('closed');
    wake?.();
  });
  socket.write(
    [
      `GET ${socketPath} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      '',
      '',
    ].join('\r\n'),
  );
  const next = async () => {
    for (let i = 0; i < 600 && !messages.length; i++)
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 10);
      });
    return messages.shift() ?? 'timeout';
  };
  return {
    socket,
    next,
    get status() {
      return status;
    },
    send: (payload: Uint8Array, opcode = 2, masked = true) =>
      socket.write(encodeWebSocketFrame(opcode, payload, masked)),
  };
}
type Raw = Awaited<ReturnType<typeof rawSocket>>;
/** Completes the handshake on a raw socket; returns the keys and both sides' next sequence. */
async function rawHello(raw: Raw, token: string, hello: Record<string, unknown> = {}) {
  const challenge = await raw.next();
  assert(challenge !== 'closed' && challenge !== 'timeout');
  const { challenge: value } = JSON.parse(challenge.payload.toString());
  const nonce = P.nonce(),
    keys = deriveSocketKeys(token, { nonce, challenge: value, host });
  const message = { type: 'hello', seq: 0, protocol: 2, host, nonce, ...hello };
  raw.send(sealSocketMessage(keys.client, message));
  return { keys, nonce, challenge: value, message };
}
async function readSealed(raw: Raw, keys: SocketKeys) {
  const message = await raw.next();
  if (message === 'closed' || message === 'timeout') return message;
  return openSocketMessage(keys.server, message.payload) as Record<string, unknown> & {
    type: string;
    seq: number;
  };
}
/** What follows a refusal: only a close frame with the policy code and no reason, if anything. */
async function assertRefused(raw: Raw) {
  for (;;) {
    const message = await raw.next();
    if (message === 'timeout') assert.fail('The connection stayed open.');
    if (message === 'closed') return;
    assert.equal(message.opcode, 8);
    assert.deepEqual([...message.payload], [0x03, 0xf0]);
  }
}

test('one connection serves requests and chat, chat-list and provider subscriptions, streaming a held reply as deltas', async (t) => {
  const gate = Promise.withResolvers<void>(),
    registry = createRegistry();
  t.after(() => gate.resolve());
  let held = false;
  registry.install(
    defineExtension({
      name: 'hold-response',
      hooks: [
        hook(GenerationTask, {
          afterResponse: async () => {
            held = true;
            await gate.promise;
          },
        }),
      ],
    }),
  );
  const f = await runtimeFixture(t, registry, { tokensPerSecond: 2000 }, true);
  const control = await (
    f.runtime as unknown as ManagedRuntime.ManagedRuntime<LocalPiControl, never>
  ).runPromise(LocalPiControl);
  const sessionOf = { host: f.config.host, actorId: f.config.actorId };
  const providerSetup = emitter();
  let state: ProviderState = providers;
  const token = P.nonce(),
    scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    serveChat(
      { host: f.config.host, token, port: 0 },
      f.client,
      daemonClient(() => state),
      localDaemonCapabilities,
      {
        sources: {
          subscribeChatList: (listener) => control.subscribeChatList(listener),
          subscribeProviderSetup: providerSetup.subscribe,
        },
      },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const socket = await open(t, { origin: server.origin, token, expected: f.config.host });
  assert(socket.health.capabilities.includes('socket-v1'));
  assert(socket.health.capabilities.includes('chat-v0'));

  const chatTarget = await f.create();
  const lists: { value: { conversations: unknown[] }; update: string }[] = [],
    chats: { value: ChatSnapshot; update: string }[] = [],
    setups: { value: ProviderState; update: string }[] = [],
    failures: ApplicationError[] = [];
  socket.subscribe('chatList', sessionOf, {
    receive: (value, update) => lists.push({ value, update }),
    onError: (error) => failures.push(error),
  });
  socket.subscribe('chat', chatTarget, {
    receive: (value, update) => chats.push({ value, update }),
    onError: (error) => failures.push(error),
  });
  socket.subscribe(
    'providerSetup',
    { host: f.config.host, ownerId: 'document' },
    {
      receive: (value, update) => setups.push({ value, update }),
      onError: (error) => failures.push(error),
    },
  );
  await until(async () => lists.length && chats.length && setups.length, Boolean);
  assert.equal(chats[0]!.update, 'snapshot');

  f.faux.setResponses([fauxAssistantMessage('streamed '.repeat(300))]);
  await socket.request('sendChat', { target: chatTarget, requestId: 'send', text: 'Stream' });
  // Before the response completes, its text arrives as appended deltas.
  await until(async () => held, Boolean);
  const live = chats.filter((view) => view.update === 'delta' && !!view.value.run);
  assert(live.length > 1, 'appended text arrives as deltas');
  // While the generation is held, the value the deltas built matches a fresh snapshot.
  await until(async () => {
    const { observationStatus: _, ...fresh } = await socket.request('getChat', {
      target: chatTarget,
    });
    const { observationStatus: __, ...built } = chats.at(-1)!.value;
    return chats.at(-1)!.update === 'delta' && isDeepStrictEqual(built, fresh);
  }, Boolean);
  gate.resolve();
  const done = await until(
    async () => chats.at(-1)!.value,
    (view) => !view.run && view.entries.some((entry) => entry.text.startsWith('streamed')),
  );
  // The committed state the updates built matches a fresh snapshot.
  const { observationStatus: _, ...fresh } = await socket.request('getChat', {
    target: chatTarget,
  });
  const { observationStatus: __, ...built } = done;
  assert.deepEqual(built, fresh);
  // The chat list's row changed as the run started and ended, as upserts.
  await until(
    async () => lists.at(-1)!.value.conversations,
    (rows) => (rows[0] as { activity?: { state: string } })?.activity?.state === 'idle',
  );
  assert(lists.slice(1).some((list) => list.update === 'delta'));

  state = {
    providers: [],
    flow: {
      id: 'flow',
      providerId: 'openai',
      state: 'running',
      message: 'Open the provider sign-in page to continue.',
      canOpenUrl: true,
      prompt: null,
    },
  };
  providerSetup.emit();
  await until(
    async () => setups.at(-1)!,
    (setup) => setup.value.flow?.id === 'flow',
  );
  assert.equal(setups.at(-1)!.update, 'delta');
  assert.deepEqual(failures, []);
});

test('the handshake and every authenticated frame refuse forgery, replay, reordering and oversize without disclosure', async (t) => {
  const source = controlledClient(),
    clock = manualClock();
  const { token, port } = await serve(t, source.client, { clock });
  // A client that holds the token is welcomed, and its frames are answered.
  {
    const raw = await rawSocket(port);
    const { keys } = await rawHello(raw, token);
    const welcome = await readSealed(raw, keys);
    assert(welcome !== 'closed' && welcome !== 'timeout');
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.seq, 0);
    raw.send(
      sealSocketMessage(keys.client, {
        type: 'request',
        seq: 1,
        id: 'r',
        operation: 'getChatHost',
        input: { host },
      }),
    );
    const reply = await readSealed(raw, keys);
    assert(reply !== 'closed' && reply !== 'timeout');
    assert.equal(reply.type, 'reply');
    // A request over an HTTP body's bound is refused, and the connection stays open.
    raw.send(
      sealSocketMessage(keys.client, {
        type: 'request',
        seq: 2,
        id: 'large',
        operation: 'getChatHost',
        input: { host, padding: 'x'.repeat(P.maximumChatRequestBytes) },
      }),
    );
    const large = await readSealed(raw, keys);
    assert(large !== 'closed' && large !== 'timeout');
    assert.equal(
      JSON.parse(Buffer.from(large.data as string, 'base64').toString()).error.code,
      'InvalidInput',
    );
    raw.socket.destroy();
  }
  const dispatched = source.calls.length;
  type Fault = (raw: Raw) => Promise<void>;
  /** Sends a valid hello, reads the welcome and then sends what `after` makes. */
  const afterWelcome =
    (after: (keys: SocketKeys, raw: Raw) => void): Fault =>
    async (raw) => {
      const { keys } = await rawHello(raw, token);
      const welcome = await readSealed(raw, keys);
      assert(welcome !== 'closed' && welcome !== 'timeout' && welcome.type === 'welcome');
      after(keys, raw);
    };
  const request = (seq: number) => ({
    type: 'request',
    seq,
    id: `r${seq}`,
    operation: 'getChat',
    input: { target },
  });
  let captured: Buffer | undefined;
  const faults: Record<string, Fault> = {
    'wrong token': async (raw) => void (await rawHello(raw, P.nonce())),
    'wrong host': async (raw) =>
      void (await rawHello(raw, token, { host: { hostId: 'other', storeId: 'socket-store' } })),
    'wrong protocol': async (raw) => void (await rawHello(raw, token, { protocol: 1 })),
    'hello out of sequence': async (raw) => void (await rawHello(raw, token, { seq: 1 })),
    'hello replayed on another connection': async (raw) => {
      await raw.next();
      raw.send(captured!);
    },
    'ping before hello': async (raw) => {
      await raw.next();
      raw.send(Buffer.alloc(8), 9);
    },
    'request before hello': async (raw) => {
      await raw.next();
      raw.send(sealSocketMessage(Buffer.alloc(32), request(0)));
    },
    'tampered frame': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, request(1));
      frame[frame.length - 3]! ^= 1;
      raw.send(frame);
    }),
    'tampered MAC': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, request(1));
      frame[0]! ^= 1;
      raw.send(frame);
    }),
    'replayed frame': afterWelcome((keys, raw) => {
      const frame = sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 });
      raw.send(frame);
      raw.send(frame);
    }),
    'reordered frames': afterWelcome((keys, raw) => {
      raw.send(sealSocketMessage(keys.client, request(2)));
      raw.send(sealSocketMessage(keys.client, request(1)));
    }),
    'missing frame': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, request(2))),
    ),
    'server frame reflected': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.server, { type: 'heartbeat', seq: 1 })),
    ),
    'unknown field': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1, extra: true })),
    ),
    'oversized frame': afterWelcome((_keys, raw) => {
      // Only the header is sent: the length alone is refused, before any payload is buffered.
      const header = Buffer.alloc(14);
      header[0] = 0x82;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(socketLimits.frameBytes + 1), 2);
      raw.socket.write(header);
    }),
    'fragmented frame': async (raw) => {
      await raw.next();
      // An empty first fragment and empty continuations would never complete a message.
      raw.socket.write(Buffer.from([0x02, 0x80, 0, 0, 0, 0]));
      raw.socket.write(
        Buffer.concat(Array.from({ length: 64 }, () => Buffer.from([0, 0x80, 0, 0, 0, 0]))),
      );
    },
    'oversized hello': async (raw) => {
      await raw.next();
      raw.send(Buffer.alloc(8192, 0x20));
    },
    'unmasked frame': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 }), 2, false),
    ),
    'text frame': afterWelcome((keys, raw) =>
      raw.send(sealSocketMessage(keys.client, { type: 'heartbeat', seq: 1 }), 1),
    ),
    'late hello': async (raw) => {
      await raw.next();
      clock.advance(socketLimits.handshakeMs);
    },
  };
  {
    // A hello captured from one connection, for replaying on another.
    const raw = await rawSocket(port);
    const challenge = await raw.next();
    assert(challenge !== 'closed' && challenge !== 'timeout');
    const nonce = P.nonce(),
      keys = deriveSocketKeys(token, {
        nonce,
        challenge: JSON.parse(challenge.payload.toString()).challenge,
        host,
      });
    captured = sealSocketMessage(keys.client, { type: 'hello', seq: 0, protocol: 2, host, nonce });
    raw.socket.destroy();
  }
  for (const [name, fault] of Object.entries(faults)) {
    const raw = await rawSocket(port);
    await fault(raw);
    await assertRefused(raw).catch((error: unknown) => {
      throw new Error(name, { cause: error });
    });
  }
  // A page in a browser always sends Origin, and is refused before any upgrade.
  const page = await rawSocket(port, { Origin: 'https://example.com' });
  assert.equal(await page.next(), 'closed');
  assert.match(page.status!, /^HTTP\/1\.1 403/);
  // Nothing refused reached the chat service.
  assert.equal(source.calls.length, dispatched);
});

test('a client refuses a daemon that cannot prove the token, skips a frame or never welcomes it', async (t) => {
  const token = P.nonce();
  for (const fault of ['wrong key', 'skipped sequence', 'held upgrade'] as const) {
    const server = createServer(),
      upgraded = new Set<{ destroy(): void }>();
    server.on('upgrade', (request, socket) => {
      upgraded.add(socket);
      if (fault === 'held upgrade') return;
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const challenge = P.nonce();
      socket.write(
        encodeWebSocketFrame(
          2,
          Buffer.from(JSON.stringify({ type: 'challenge', protocol: 2, challenge })),
        ),
      );
      const reader = new WebSocketReader(1 << 20, true);
      socket.on('data', (bytes: Buffer) => {
        for (const { opcode, payload } of reader.push(bytes)) {
          if (opcode !== 2) continue;
          const hello = JSON.parse(payload.subarray(32).toString());
          const keys = deriveSocketKeys(fault === 'wrong key' ? P.nonce() : token, {
            nonce: hello.nonce,
            challenge,
            host,
          });
          const health = {
            ...host,
            protocol: 2,
            version: '0.1.0',
            capabilities: ['chat-v0', 'socket-v1'],
          };
          socket.write(
            encodeWebSocketFrame(
              2,
              sealSocketMessage(keys.server, {
                type: 'welcome',
                seq: fault === 'skipped sequence' ? 1 : 0,
                health,
              }),
            ),
          );
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as { port: number };
    const endpoint = { origin: `http://127.0.0.1:${port}`, token, expected: host };
    if (fault !== 'held upgrade') {
      await assert.rejects(connectDaemonSocket(endpoint), { code: 'Unauthorized' }, fault);
      continue;
    }
    // A slow forward gets the HTTP stream's establishment budget, past the server's hello bound.
    const clock = manualClock();
    let settled = false;
    const connecting = connectDaemonSocket(endpoint, { clock });
    void connecting.catch(() => {}).finally(() => (settled = true));
    await until(async () => upgraded.size, Boolean);
    clock.advance(socketLimits.connectMs - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert(!settled);
    clock.advance(1);
    await assert.rejects(connecting, { code: 'Unavailable' });
  }
});

test('reconnecting resumes from kept deltas or resets with a snapshot, and a mutation in flight is Uncertain and never resent', async (t) => {
  const source = controlledClient();
  const sends: string[] = [],
    hold = Promise.withResolvers<void>();
  t.after(() => hold.resolve());
  source.handlers.sendChat = async (input: { requestId: string }) => {
    sends.push(input.requestId);
    await hold.promise;
    return {
      target,
      requestId: input.requestId,
      admission: 'admitted',
      submissionId: 's',
    };
  };
  const { endpoint } = await serve(t, source.client);
  const first = await open(t, endpoint);
  const views: string[] = [];
  const subscription = first.subscribe('chat', target, {
    receive: (value, update) => views.push(`${update}:${value.run?.text}`),
    onError: () => {},
  });
  await until(
    async () => views.length,
    (count) => count === 1,
  );
  const before = subscription.state!;
  source.publish(snapshotOf('one'));
  source.publish(snapshotOf('one two'));
  await until(
    async () => views.length,
    (count) => count === 3,
  );
  assert.deepEqual(views, ['snapshot:', 'delta:one', 'delta:one two']);

  const sending = first.request('sendChat', { target, requestId: 'send', text: 'Hello' });
  await until(async () => sends.length, Boolean);
  first.close();
  await assert.rejects(sending, { code: 'Uncertain' });
  await until(
    async () => source.watching,
    (count) => count === 0,
  );
  source.publish(snapshotOf('one two three'));

  // Resuming after the first update replays the kept deltas, then continues with deltas.
  const second = await open(t, endpoint);
  const resumed: string[] = [],
    takenOver = Promise.withResolvers<ApplicationError>();
  second.subscribe(
    'chat',
    target,
    {
      receive: (value, update) => resumed.push(`${update}:${value.run?.text}`),
      onError: takenOver.resolve,
    },
    before,
  );
  await until(
    async () => resumed.length,
    (count) => count === 3,
  );
  assert.deepEqual(resumed, ['delta:one', 'delta:one two', 'delta:one two three']);
  // A position the daemon no longer has resets with a fresh snapshot.
  const third = await open(t, endpoint);
  const reset: string[] = [];
  third.subscribe(
    'chat',
    target,
    { receive: (value, update) => reset.push(`${update}:${value.run?.text}`), onError: () => {} },
    { ...before, subscriptionId: P.nonce() },
  );
  await until(async () => reset.length, Boolean);
  assert.deepEqual(reset, ['snapshot:one two three']);
  // Another connection taking the subscription over ends it on the one that held it.
  third.subscribe('chat', target, { receive: () => {}, onError: () => {} }, before);
  assert.equal((await takenOver.promise).code, 'Conflict');
  // Nothing was sent again; a retry carries the original request ID.
  assert.deepEqual(sends, ['send']);
  hold.resolve();
  const retried = await second.request('sendChat', { target, requestId: 'send', text: 'Hello' });
  assert.equal(retried.requestId, 'send');
});

test('a slow consumer is reset with a snapshot rather than a backlog, Stop stays responsive under streaming, and a stalled one is dropped', async (t) => {
  const source = controlledClient(),
    clock = manualClock();
  let stops = 0;
  source.handlers.stopChat = async (input: { requestId: string; stop: unknown }) => {
    stops++;
    return { stop: input.stop, requestId: input.requestId, outcome: 'stopped' };
  };
  const { token, port, endpoint } = await serve(t, source.client, { clock });
  // Under continuous streaming, Stop's reply comes before many more updates.
  {
    const socket = await open(t, endpoint);
    let updates = 0,
      streaming = true,
      text = '';
    socket.subscribe('chat', target, { receive: () => updates++, onError: () => {} });
    await until(async () => updates, Boolean);
    const stream = () => {
      if (!streaming) return;
      text += `${text.length} `;
      source.publish(snapshotOf(text, 30));
      setImmediate(stream);
    };
    stream();
    await until(
      async () => updates,
      (count) => count > 20,
    );
    const at = updates;
    const stopped = await socket.request('stopChat', {
      stop: { target, submissionId: 's', taskId: 't' },
      requestId: 'stop',
    });
    streaming = false;
    assert.equal(stopped.outcome, 'stopped');
    assert(updates - at < 20, `Stop waited for ${updates - at} updates`);
    socket.close();
  }
  // A reader that stops reading gets a fresh snapshot of the latest state, not every update.
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  assert.equal(((await readSealed(raw, keys)) as { type: string }).type, 'welcome');
  const subscriptionId = P.nonce();
  raw.send(
    sealSocketMessage(keys.client, {
      type: 'subscribe',
      seq: 1,
      subscriptionId,
      kind: 'chat',
      target,
    }),
  );
  raw.socket.pause();
  const published = 60;
  for (let index = 0; index < published; index++) {
    source.publish(snapshotOf(`${index}`, 30, `${index}`));
    await new Promise((resolve) => setImmediate(resolve));
  }
  raw.socket.resume();
  const assembler = new PayloadAssembler();
  const received: { kind: string; value?: ChatSnapshot }[] = [];
  while (received.at(-1)?.value?.run?.text !== `${published - 1}`) {
    const message = await readSealed(raw, keys);
    assert(message !== 'closed' && message !== 'timeout');
    if (message.type !== 'update') continue;
    if (message.kind === 'snapshot') {
      const done = assembler.push(`${message.sequence}`, message as never);
      if (done) received.push({ kind: 'snapshot', value: done.value as ChatSnapshot });
    } else received.push({ kind: String(message.kind) });
  }
  assert(received.length < published / 2, `${received.length} updates for ${published}`);
  assert.equal(received.at(-1)!.kind, 'snapshot');
  // One that leaves the socket full past the drain bound is disconnected.
  raw.socket.pause();
  for (let index = 0; index < published; index++) {
    source.publish(snapshotOf(`again ${index}`, 30, `again ${index}`));
    await new Promise((resolve) => setImmediate(resolve));
  }
  // A subscription whose source ended before its error was sent starts again when resumed.
  source.end(new ApplicationError({ code: 'Unavailable', message: 'Watch ended.' }));
  const resumed = await open(t, endpoint);
  const restarted: string[] = [];
  resumed.subscribe(
    'chat',
    target,
    {
      receive: (value, update) => restarted.push(`${update}:${value.run?.text}`),
      onError: () => {},
    },
    { subscriptionId, sequence: 0, value: received.at(-1)!.value! },
  );
  await until(async () => restarted.length, Boolean);
  assert.deepEqual(restarted, [`snapshot:again ${published - 1}`]);
  clock.advance(socketLimits.drainMs);
  raw.socket.resume();
  for (;;) {
    const message = await raw.next();
    assert.notEqual(message, 'timeout');
    if (message === 'closed') break;
  }
  assert.equal(stops, 1);
});

test('a ping flood that never reads stops being read and is dropped, and held handshakes give way to new ones', async (t) => {
  const source = controlledClient(),
    clock = manualClock();
  const { token, port, endpoint } = await serve(t, source.client, { clock });
  const client = await open(t, endpoint, clock);
  // Pings are answered, but the daemon stops reading once its answers go unread.
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  assert.equal(((await readSealed(raw, keys)) as { type: string }).type, 'welcome');
  raw.socket.pause();
  const ping = encodeWebSocketFrame(9, Buffer.alloc(125, 1), true),
    batch = Buffer.concat(Array.from({ length: 1000 }, () => ping));
  // About 21 MB: past the 1 MiB bound plus what loopback buffers absorb (up to 4 MiB on each
  // side of each direction on macOS), so the daemon must stop reading.
  for (let index = 0; index < 160; index++) raw.socket.write(batch);
  // What the daemon has not read stays queued here instead of as answers in the daemon.
  await until(async () => {
    const queued = raw.socket.writableLength;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return queued > 0 && raw.socket.writableLength === queued;
  }, Boolean);
  // A flood left unread for `drainMs` is dropped.
  clock.advance(socketLimits.drainMs);
  raw.socket.resume();
  for (;;) {
    const message = await raw.next();
    if (message === 'closed') break;
    assert(message !== 'timeout' && [2, 8, 10].includes(message.opcode));
  }
  // Connections still waiting for a hello have their own bound: a new one evicts the oldest, so
  // a client still connects while every slot is held, and an authenticated one is unaffected.
  const waiting = await Promise.all(Array.from({ length: 8 }, () => rawSocket(port)));
  for (const pending of waiting) assert.notEqual(await pending.next(), 'timeout');
  const later = await open(t, endpoint, clock);
  await assertRefused(waiting.shift()!);
  assert.equal((await later.request('getChatHost', { host })).actorId, 'owner');
  assert.equal((await client.request('getChatHost', { host })).actorId, 'owner');
  clock.advance(socketLimits.handshakeMs);
  for (const pending of waiting) await assertRefused(pending);
});

test('subscriptions are bounded, reads and watches end with their connection, and a silent client is dropped', async (t) => {
  const source = controlledClient(),
    clock = manualClock();
  const reads: AbortSignal[] = [];
  source.handlers.findChatFiles = (_input, signal) =>
    new Promise((_resolve, reject) => {
      reads.push(signal!);
      signal!.addEventListener('abort', () =>
        reject(new ApplicationError({ code: 'Cancelled', message: 'Cancelled.' })),
      );
    });
  const { endpoint, token, port } = await serve(t, source.client, { clock });
  const socket = await open(t, endpoint, clock);
  const errors: string[] = [];
  for (let index = 0; index <= socketLimits.subscriptions; index++)
    socket.subscribe('chat', target, {
      receive: () => {},
      onError: (error) => errors.push(error.code),
    });
  await until(async () => errors.length, Boolean);
  assert.deepEqual(errors, ['Unavailable']);
  await until(
    async () => source.watching,
    (count) => count === socketLimits.subscriptions,
  );

  // A cancelled read is aborted on the daemon; closing the connection aborts the rest and
  // closes every watch.
  const controller = new AbortController();
  const cancelled = socket.request(
    'findChatFiles',
    { target, query: 'a' },
    { signal: controller.signal },
  );
  const open1 = socket.request('findChatFiles', { target, query: 'b' });
  await until(
    async () => reads.length,
    (count) => count === 2,
  );
  controller.abort();
  await assert.rejects(cancelled, { code: 'Cancelled' });
  await until(async () => reads[0]!.aborted, Boolean);
  assert.equal(reads[1]!.aborted, false);
  socket.close();
  await assert.rejects(open1, { code: 'Unavailable' });
  await until(async () => reads[1]!.aborted && source.watching === 0, Boolean);

  // A silent client gets heartbeats, then is dropped once idle.
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  assert.equal(((await readSealed(raw, keys)) as { type: string }).type, 'welcome');
  clock.advance(socketLimits.heartbeatMs);
  assert.equal(((await readSealed(raw, keys)) as { type: string }).type, 'heartbeat');
  clock.advance(socketLimits.idleMs - socketLimits.heartbeatMs);
  await assertRefused(raw);
});
