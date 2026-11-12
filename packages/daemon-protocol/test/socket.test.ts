import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { connect, type AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Effect, Exit, Queue, Scope, Stream, type Cause } from 'effect';
import { GenerationTask, createRegistry, defineExtension, hook } from '@earendil-works/pi-durable';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatClient, ChatListUpdate, ChatSnapshot } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import type { ProviderState } from '@moonbase/contracts/providers';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type {
  HostCommand,
  HostInput,
  HostOutput,
  WorkspaceHostClient,
} from '@moonbase/contracts/workspace-host';
import { maximumFileBytes, type WorkspaceEvent } from '@moonbase/contracts/workspace';
import { socketLimits, socketPath } from '@moonbase/contracts/socket';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  chatHostCapabilities,
  chatHostVersion,
  chatProtocolVersion,
  type ChatHostHealth,
} from '@moonbase/contracts/host';
import { checkHostHealth, healthDomain } from '@moonbase/ssh/host-health';
import {
  localDaemonCapabilities,
  makeWorkspaceClient,
  serveChat,
  type SocketSources,
} from '../src/server.ts';
import { connectDaemonSocket } from '../src/socket-client.ts';
import { createSocketServer } from '../src/socket-server.ts';
import {
  deriveSocketKeys,
  systemSocketClock,
  openSocketMessage,
  PayloadAssembler,
  PayloadReassembly,
  sealSocketMessage,
  type SocketClock,
  type SocketKeys,
} from '../src/socket-protocol.ts';
import { encodeWebSocketFrame, WebSocketReader } from '../src/websocket.ts';
import * as P from '../src/protocol.ts';
import { fixture as runtimeFixture, manualClock, until } from './runtime-fixture.ts';

const host = { hostId: 'socket-host', storeId: 'socket-store' };
const session = { host, actorId: 'owner' };
const target = { ...session, conversationId: 'A' };
const providers: ProviderState = { providers: [], flow: null };

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
    watchChatList: () => async () => {},
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
  options: {
    daemon?: DaemonClient;
    sources?: Partial<SocketSources>;
    clock?: SocketClock;
    workspace?: WorkspaceHostClient;
    admit?: () => () => void;
  } = {},
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
          subscribeProviderSetup: () => () => {},
          ...options.sources,
        },
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.admit ? { admit: options.admit } : {}),
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
  const f = await runtimeFixture(t, registry, { tokensPerSecond: 2000 });
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
  const lists: { value: { list: { conversations: unknown[] } }; update: string }[] = [],
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
    async () => lists.at(-1)!.value.list.conversations,
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
  // Flood until the daemon's unread answers pass its bound and it stops reading, which arms its
  // drain timer: however much the loopback buffers absorb, and however slowly it reads.
  await until(async () => {
    while (raw.socket.writableLength < 1024 * 1024) raw.socket.write(batch);
    return clock.hasTimer(socketLimits.drainMs);
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

test('unauthenticated health probes are refused before they reach the chat service', async (t) => {
  const { client, calls } = controlledClient();
  const served = await serve(t, client);
  const probe = P.nonce(),
    before = calls.length;
  const proof = (key: string) =>
    'Moonbase-HMAC-SHA256 ' +
    createHmac('sha256', key)
      .update(JSON.stringify([healthDomain, 'request', probe]))
      .digest('hex');
  for (const headers of [
    {},
    { 'X-Moonbase-Nonce': probe },
    { 'X-Moonbase-Nonce': probe, Authorization: 'Moonbase-HMAC-SHA256 ' + '0'.repeat(64) },
    { 'X-Moonbase-Nonce': probe, Authorization: proof(P.nonce()) },
  ] as Record<string, string>[]) {
    const response = await fetch(`${served.endpoint.origin}/v1/health`, { headers });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  assert.deepEqual(calls.slice(before), []);
  // A probe with the token's proof is answered, after asking the chat service.
  await Effect.runPromise(
    checkHostHealth({ origin: served.endpoint.origin, token: served.token, expected: host }),
  );
  assert.deepEqual(calls.slice(before), ['getChatHost']);
});

test('daemon requests are bound to this host and their request ID; a substituted reply is refused, a mutation’s as Uncertain', async (t) => {
  // The daemon refuses another host's request and a request ID reused for another input, and
  // dispatches neither.
  const dispatched: unknown[] = [];
  const daemon: DaemonClient = {
    command: async (operation, input) => {
      dispatched.push(input);
      if (operation === 'approveFolder') {
        const { requestId, path } = input as { requestId: string; path: string };
        return { requestId, path } as never;
      }
      return daemonClient().command(operation, input as never);
    },
  };
  const served = await serve(t, controlledClient().client, { daemon });
  const socket = await open(t, served.endpoint);
  const approve = { host, requestId: 'approve', path: '/folder' },
    approved = { requestId: 'approve', path: '/folder' };
  assert.deepEqual(await socket.request('approveFolder', approve), approved);
  await assert.rejects(
    socket.request('approveFolder', { ...approve, host: { ...host, storeId: 'other' } }),
    { code: 'Unauthorized' },
  );
  await assert.rejects(socket.request('approveFolder', { ...approve, path: '/other' }), {
    code: 'InvalidInput',
  });
  assert.deepEqual(await socket.request('approveFolder', approve), approved);
  assert.deepEqual(dispatched, [approve]);

  // A daemon that can prove the token but answers with another request's reply or another
  // read's content is refused by the client.
  let substitute: (operation: string, input: Record<string, unknown>) => unknown = () => null;
  const token = P.nonce(),
    health: ChatHostHealth = {
      ...host,
      protocol: chatProtocolVersion,
      version: chatHostVersion,
      capabilities: [
        chatHostCapabilities.chat,
        ...localDaemonCapabilities,
        chatHostCapabilities.socket,
      ],
    };
  let publishList: ((update: ChatListUpdate) => void) | undefined;
  const sockets = createSocketServer({
    token,
    host,
    health,
    client: {
      ...controlledClient().client,
      watchChatList: (_input, receive) => {
        publishList = receive;
        return async () => {};
      },
    },
    sources: {},
    clock: systemSocketClock,
    answer: async (operation, input) => ({
      ok: true,
      value: substitute(operation, input as Record<string, unknown>),
    }),
  });
  const hostile = createServer((_request, response) => response.writeHead(404).end());
  hostile.on('upgrade', (request, upgraded, head) => sockets.upgrade(request, upgraded, head));
  await new Promise<void>((resolve) => hostile.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await sockets.close();
    await new Promise<void>((resolve) => hostile.close(() => resolve()));
  });
  const endpoint = {
    origin: `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`,
    token,
    expected: host,
  };
  const client = await open(t, endpoint);
  substitute = () => ({ ...approved, requestId: 'another' });
  await assert.rejects(client.request('approveFolder', approve), { code: 'Uncertain' });
  substitute = () => ({ state: { providers: 'none' } });
  await assert.rejects(client.request('getProviders', { host, ownerId: 'document' }), {
    code: 'Incompatible',
  });
  const source = { kind: 'entry' as const, target, entryId: 'e0' },
    selection = { partId: 'p0', bytes: 3, revision: 'a'.repeat(64) };
  const content = {
    kind: 'content',
    cursor: null,
    source,
    selection,
    offset: 0,
    nextCursor: null,
    encoding: 'utf8',
    data: 'abc',
  };
  for (const changed of [
    { source: { ...source, target: { ...target, actorId: 'other' } } },
    { selection: { ...selection, partId: 'other' } },
    { cursor: 'other' },
  ]) {
    substitute = () => ({ ...content, ...changed });
    await assert.rejects(client.request('getChatTranscriptContent', { source, selection }), {
      code: 'Incompatible',
    });
  }
  // A signed chat reply that reflects another chat or session is refused too, and the same reply
  // for its own chat is accepted.
  const row = (owner: typeof target) => ({ ...snapshotOf(null).conversation, target: owner }),
    foreign = { ...target, actorId: 'other' };
  for (const [operation, input, reply] of [
    [
      'getChat',
      { target },
      (owner: typeof target) => ({ ...snapshotOf(null), conversation: row(owner) }),
    ],
    [
      'listChats',
      { session },
      (owner: typeof target) => ({ conversations: [row(owner)], nextCursor: null }),
    ],
  ] as const) {
    substitute = () => reply(foreign);
    await assert.rejects(client.request(operation, input as never), { code: 'Incompatible' });
    substitute = () => reply(target);
    assert.deepEqual(await client.request(operation, input as never), reply(target));
  }
  // The unchanged reply is accepted, so each refusal above was the substitution's.
  substitute = () => content;
  assert.deepEqual(
    await client.request('getChatTranscriptContent', { source, selection }),
    content,
  );
  // A signed chat list naming another session's chats is refused, in a snapshot's first page or
  // in a delta's chats past it; the same list for its own session is accepted.
  const list = (first: typeof target, past: typeof target) => ({
    list: { conversations: [row(first)], nextCursor: null },
    changed: [row(past)],
    dropped: 0,
    reset: false,
  });
  for (const updates of [[list(foreign, target)], [list(target, target), list(target, foreign)]]) {
    publishList = undefined;
    const watcher = await open(t, endpoint),
      values: unknown[] = [],
      failures: ApplicationError[] = [];
    watcher.subscribe('chatList', session, {
      receive: (value) => values.push(value),
      onError: (error) => failures.push(error),
    });
    await until(async () => publishList, Boolean);
    for (const [index, update] of updates.entries()) {
      publishList!(update);
      if (index < updates.length - 1)
        await until(
          async () => values.length,
          (count) => count === index + 1,
        );
    }
    await until(async () => failures.length, Boolean);
    assert.equal(failures[0]!.code, 'Incompatible');
    assert.equal(values.length, updates.length - 1);
  }
});

// The workspace file host over the socket: chunked requests, bounded replies and its watch.
const checkout = {
  vcs: 'none',
  hostId: host.hostId,
  checkoutId: 'checkout-1',
  projectId: 'project-1',
  root: '/work',
} as const;
const fileTarget = { checkout, path: 'a.txt' };
const chunkBytes = socketLimits.chunkBytes;
type Handler = (input: never, signal?: AbortSignal) => Promise<unknown>;
/** A file host whose operations the test answers; unanswered ones fail. */
function controlledWorkspace() {
  const handlers: Partial<Record<HostCommand, Handler>> = {},
    calls: HostCommand[] = [];
  const client: WorkspaceHostClient = {
    command: async <K extends HostCommand>(
      operation: K,
      input: HostInput<K>,
      options?: { signal?: AbortSignal },
    ) => {
      calls.push(operation);
      const handler = handlers[operation];
      if (!handler)
        throw new ApplicationError({ code: 'Unavailable', message: 'Unexpected operation.' });
      return (await handler(input as never, options?.signal)) as HostOutput<K>;
    },
    watch: () => () => Promise.resolve(),
  };
  return { client, handlers, calls };
}
const saveInput = (text: string, requestId = 'save-1') => ({
  installationId: 'install',
  clientId: 'client',
  requestId,
  target: fileTarget,
  text,
  expectedVersion: 'v0',
});
/** The frames of a request body sent as chunks. */
const chunkMessages = (id: string, body: Buffer, total = body.length) =>
  Array.from({ length: Math.ceil(body.length / chunkBytes) }, (_, index) => ({
    type: 'requestChunk',
    id,
    offset: index * chunkBytes,
    total,
    data: body.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64'),
  }));
const padded = (size: number) =>
  Buffer.from(JSON.stringify({ operation: 'readFile', input: { padding: 'x'.repeat(size) } }));
/** An authenticated raw connection to a server that serves `workspace`, sealing frames in order. */
async function workspaceConnection(t: TestContext, workspace: WorkspaceHostClient) {
  const source = controlledClient(),
    clock = manualClock();
  const { token, port } = await serve(t, source.client, { clock, workspace });
  const raw = await rawSocket(port);
  const { keys } = await rawHello(raw, token);
  const welcome = await readSealed(raw, keys);
  assert(welcome !== 'closed' && welcome !== 'timeout' && welcome.type === 'welcome');
  assert((welcome.health as { capabilities: string[] }).capabilities.includes('workspace-v1'));
  let seq = 1;
  const seal = (message: Record<string, unknown>) =>
    sealSocketMessage(keys.client, { ...message, seq: seq++ });
  return {
    raw,
    keys,
    source,
    clock,
    seal,
    send: (message: Record<string, unknown>) => raw.send(seal(message)),
  };
}

const chunkFaults: Record<
  string,
  (c: Awaited<ReturnType<typeof workspaceConnection>>, body: Buffer) => void
> = {
  tampered: (c, body) => {
    const frame = c.seal(chunkMessages('r', body)[0]!);
    frame[40] ^= 1;
    c.raw.send(frame);
  },
  replayed: (c, body) => {
    const frame = c.seal(chunkMessages('r', body)[0]!);
    c.raw.send(frame);
    c.raw.send(frame);
  },
  reordered: (c, body) => c.send(chunkMessages('r', body)[1]!),
  interleaved: (c, body) => {
    c.send(chunkMessages('r', body)[0]!);
    c.send({ type: 'heartbeat' });
  },
  oversized: (c, body) =>
    c.send({
      ...chunkMessages('r', body)[0]!,
      data: Buffer.alloc(chunkBytes + 1, 1).toString('base64'),
    }),
  'over its total bound': (c, body) =>
    c.send({
      ...chunkMessages('r', body)[0]!,
      total: socketLimits.workspaceRequestBytes + 1,
    }),
  // Base64 whose padding hides set bits decodes, but is not the one encoding of its bytes.
  'non-canonical': (c, body) => c.send({ ...chunkMessages('r', body)[0]!, data: 'AB==' }),
  'chat operation': (c) => {
    const body = Buffer.from(
      JSON.stringify({
        operation: 'listChats',
        input: { session, padding: 'x'.repeat(chunkBytes) },
      }),
    );
    for (const message of chunkMessages('r', body)) c.send(message);
  },
};
for (const [name, fault] of Object.entries(chunkFaults))
  test(`a ${name} request chunk closes the connection`, async (t) => {
    const connection = await workspaceConnection(t, controlledWorkspace().client);
    fault(connection, padded(chunkBytes * 2));
    await assertRefused(connection.raw);
  });

test('a request past 32 MiB of chunked input in flight is refused Unavailable before it runs, a mutation too, and its discarded chunks are still checked', async (t) => {
  const { client, handlers, calls } = controlledWorkspace(),
    held = Promise.withResolvers<never>();
  handlers.getIgnoredPaths = () => held.promise;
  t.after(() => held.reject(Error('done')));
  // About 16.4 MB each: two fit, and each holds its input while the host runs it.
  const holding = {
    checkout,
    path: '',
    paths: Array.from({ length: 4100 }, () => 'x'.repeat(4000)),
  };
  const body = Buffer.from(JSON.stringify({ operation: 'getIgnoredPaths', input: holding }));
  assert(body.length < socketLimits.workspaceRequestBytes);
  assert(body.length * 3 > socketLimits.workspaceInFlightBytes);
  const { endpoint } = await serve(t, controlledClient().client, { workspace: client });
  const socket = await open(t, endpoint);
  for (let index = 0; index < 2; index++)
    void socket.request('getIgnoredPaths', holding).catch(() => {});
  await until(
    async () => calls.length,
    (count) => count === 2,
  );
  // A mutation that would pass the bound never runs, so it is `Unavailable`, not `Uncertain`, and
  // the connection carries on.
  const text = 'x'.repeat(1024 * 1024);
  await assert.rejects(socket.request('saveFile', saveInput(text)), { code: 'Unavailable' });
  assert.deepEqual(calls, ['getIgnoredPaths', 'getIgnoredPaths']);
  handlers.readFile = async () => ({ text: 'ok', version: 'v1' });
  assert.equal((await socket.request('readFile', fileTarget)).text, 'ok');

  // A discarded request's chunks are checked like any other's: a gap closes the connection.
  const connection = await workspaceConnection(t, client);
  for (const id of ['a', 'b'])
    for (const message of chunkMessages(id, body)) connection.send(message);
  const [first, , third] = chunkMessages('c', body);
  connection.send(first!);
  connection.send(third!);
  await assertRefused(connection.raw);
});

test('a 2 MiB file saves and reads back through chunks, a reply over its bound is refused unsent and a host without the capability is refused locally', async (t) => {
  const stored = new Map<string, string>(),
    { client, handlers, calls } = controlledWorkspace();
  handlers.saveFile = async (input: ReturnType<typeof saveInput>) => {
    stored.set(input.target.path, input.text);
    return { kind: 'saved', version: 'v1' };
  };
  handlers.readFile = async (input: { path: string }) =>
    input.path === 'huge'
      ? { text: 'x'.repeat(socketLimits.workspaceReplyBytes + 1), version: 'v1' }
      : { text: stored.get(input.path)!, version: 'v1' };
  const { endpoint } = await serve(t, controlledClient().client, { workspace: client });
  const socket = await open(t, endpoint);
  const text = 'line "quoted"\n'.repeat(Math.floor((2 * 1024 * 1024) / 14));
  assert(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  const saved = await socket.request('saveFile', saveInput(text));
  assert.equal(saved.kind, 'saved');
  assert.equal((await socket.request('readFile', fileTarget)).text, text);
  // The host's reply is refused before any of it is sent; the connection carries on.
  await assert.rejects(socket.request('readFile', { checkout, path: 'huge' }), {
    code: 'InvalidInput',
  });
  assert.equal((await socket.request('readFile', fileTarget)).text, text);

  // A daemon that composes no file host advertises none; its clients send nothing to it.
  const bare = await serve(t, controlledClient().client);
  const plain = await open(t, bare.endpoint);
  assert(!plain.health.capabilities.includes('workspace-v1'));
  const before = calls.length;
  await assert.rejects(plain.request('readFile', fileTarget), { code: 'Incompatible' });
  assert.equal(calls.length, before);
  // A chunk to such a daemon is a protocol violation.
  const raw = await rawSocket(bare.port);
  const { keys } = await rawHello(raw, bare.token);
  await readSealed(raw, keys);
  raw.send(sealSocketMessage(keys.client, { seq: 1, ...chunkMessages('r', padded(100))[0]! }));
  await assertRefused(raw);
});

test('a workspace watch follows changes, resets after a reconnect without crowding out chats kept to resume, counts apart from chat subscriptions and ends retryably when the host’s watch finishes', async (t) => {
  const watchers = new Set<Queue.Queue<WorkspaceEvent, Cause.Done>>();
  const service = {
    watch: () =>
      Stream.callback<WorkspaceEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            watchers.add(queue);
            Queue.offerUnsafe(queue, { checkout, paths: [], ready: true });
          }),
          () => Effect.sync(() => void watchers.delete(queue)),
        ),
      ),
  } as unknown as WorkspaceHostServiceShape;
  const source = controlledClient();
  const { endpoint } = await serve(t, source.client, { workspace: makeWorkspaceClient(service) });
  const first = await open(t, endpoint);
  const chat = first.subscribe('chat', target, { receive: () => {}, onError: () => {} });
  const values: { ready: boolean; revision: number }[] = [];
  const subscription = first.subscribe(
    'workspace',
    { checkout },
    { receive: (value) => values.push(value), onError: () => {} },
  );
  await until(async () => values.at(-1)?.ready && chat.state, Boolean);
  const revision = values.at(-1)!.revision;
  for (const queue of watchers) Queue.offerUnsafe(queue, { checkout, paths: [''] });
  await until(
    async () => values.at(-1)!.revision,
    (value) => value > revision,
  );
  // A full set of workspace subscriptions beside the chat one.
  for (let index = 1; index < socketLimits.workspaceSubscriptions; index++)
    first.subscribe('workspace', { checkout }, { receive: () => {}, onError: () => {} });
  await until(
    async () => watchers.size,
    (count) => count === socketLimits.workspaceSubscriptions,
  );

  // A resumed workspace subscription always starts again from a snapshot, and workspace
  // subscriptions are not kept to resume, so the chat one still resumes with deltas.
  const state = subscription.state!,
    chatState = chat.state!;
  await first.close();
  const second = await open(t, endpoint);
  const updates: string[] = [],
    chatUpdates: string[] = [];
  second.subscribe(
    'workspace',
    { checkout },
    { receive: (_value, update) => updates.push(update), onError: () => {} },
    state,
  );
  second.subscribe(
    'chat',
    target,
    { receive: (_value, update) => chatUpdates.push(update), onError: () => {} },
    chatState,
  );
  await until(async () => updates.length, Boolean);
  assert.equal(updates[0], 'snapshot');
  source.publish(snapshotOf('resumed'));
  await until(async () => chatUpdates.length, Boolean);
  assert.equal(chatUpdates[0], 'delta');

  // 64 workspace subscriptions fit beside the chat ones; the next is refused.
  const refused: string[] = [],
    ended: string[] = [];
  for (let index = 1; index < socketLimits.workspaceSubscriptions; index++)
    second.subscribe(
      'workspace',
      { checkout },
      { receive: () => {}, onError: (error) => ended.push(error.code) },
    );
  second.subscribe(
    'workspace',
    { checkout },
    { receive: () => {}, onError: (error) => refused.push(error.code) },
  );
  await until(async () => refused.length, Boolean);
  assert.equal(refused[0], 'Unavailable');
  const chats: string[] = [];
  second.subscribe('chat', target, { receive: () => chats.push('ok'), onError: () => {} });
  await until(async () => chats.length, Boolean);

  // A host watch that finishes ends its subscriptions as `Unavailable`, which a client retries.
  for (const queue of watchers) Queue.endUnsafe(queue);
  await until(
    async () => ended.length,
    (count) => count === socketLimits.workspaceSubscriptions - 1,
  );
  assert(ended.every((code) => code === 'Unavailable'));
});

test('a mutation whose reply is lost is Uncertain, runs to completion without a signal, and its outcome is read back by operationStatus', async (t) => {
  const { client, handlers } = controlledWorkspace(),
    gate = Promise.withResolvers<void>(),
    outcomes = new Map<string, unknown>();
  let signal: AbortSignal | undefined | 'none' = 'none';
  const operation = {
    installationId: 'install',
    id: 'op-1',
    clientId: 'client',
    checkout,
    kind: 'create-file' as const,
    sources: [],
    destination: 'new.txt',
    text: 'x',
  };
  handlers.mutate = async (_input, received) => {
    signal = received;
    await gate.promise;
    const result = {
      id: 'op-1',
      clientId: 'client',
      checkout,
      kind: 'create-file',
      outcome: 'completed',
      items: [],
    };
    outcomes.set('op-1', result);
    return result;
  };
  handlers.operationStatus = async () => outcomes.get('op-1') ?? null;
  const { endpoint } = await serve(t, controlledClient().client, { workspace: client });
  const first = await open(t, endpoint);
  const lost = first.request('mutate', operation);
  const rejected = assert.rejects(lost, { code: 'Uncertain' });
  await until(
    async () => signal,
    (value) => value !== 'none',
  );
  await first.close();
  await rejected;
  // The connection closing does not cancel the mutation.
  assert.equal(signal, undefined);
  gate.resolve();
  const second = await open(t, endpoint);
  const status = await until(
    () =>
      second.request('operationStatus', {
        installationId: 'install',
        clientId: 'client',
        id: 'op-1',
      }),
    Boolean,
  );
  assert.equal(status!.outcome, 'completed');
});

test('large workspace replies and chat updates interleave on one connection and all arrive', async (t) => {
  const { client, handlers } = controlledWorkspace(),
    source = controlledClient();
  const big = (letter: string) => ({
    text: letter.repeat(maximumFileBytes),
    version: `v-${letter}`,
  });
  const gate = Promise.withResolvers<void>();
  handlers.readFile = async (input: { path: string }) => {
    await gate.promise;
    return big(input.path.slice(0, 1));
  };
  const { endpoint } = await serve(t, source.client, { clock: manualClock(), workspace: client });
  const socket = await open(t, endpoint);
  const failures: ApplicationError[] = [],
    texts: (string | undefined)[] = [];
  socket.subscribe('chat', target, {
    receive: (value) => texts.push(value.run?.text),
    onError: (error) => failures.push(error),
  });
  await until(async () => texts.length, Boolean);
  // Three replies and the chat updates share the connection while the daemon's buffer is full.
  const reads = ['a.txt', 'b.txt', 'c.txt'].map((path) =>
    socket.request('readFile', { ...fileTarget, path }),
  );
  gate.resolve();
  let streaming = true,
    published = 0;
  const stream = () => {
    if (!streaming) return;
    source.publish(snapshotOf(`update ${++published}`, 30));
    setImmediate(stream);
  };
  stream();
  const results = await Promise.all(reads);
  streaming = false;
  assert.deepEqual(
    results.map((result) => [result.version, result.text.length]),
    [
      ['v-a', maximumFileBytes],
      ['v-b', maximumFileBytes],
      ['v-c', maximumFileBytes],
    ],
  );
  assert(texts.length > 1, 'no chat update arrived during the replies');
  // The stream still delivers after the replies, and nothing failed along the way.
  source.publish(snapshotOf('last', 30));
  await until(
    async () => texts.at(-1),
    (text) => text === 'last',
  );
  assert.deepEqual(failures, []);
});

test('the daemon refuses a workspace request or watch for another host, and no handler runs', async (t) => {
  const { client, calls } = controlledWorkspace();
  const { endpoint } = await serve(t, controlledClient().client, { workspace: client });
  const socket = await open(t, endpoint);
  const foreign = { ...checkout, hostId: 'other-host' };
  await assert.rejects(socket.request('readFile', { checkout: foreign, path: 'a.txt' }), {
    code: 'Unauthorized',
  });
  // A chat named by another host is refused the same way.
  await assert.rejects(
    socket.request('turnChatIntoProject', {
      installationId: 'install',
      requestId: 'turn',
      target: { ...target, host: { ...host, hostId: 'other-host' } },
    }),
    { code: 'Unauthorized' },
  );
  const failures: string[] = [];
  socket.subscribe(
    'workspace',
    { checkout: foreign },
    { receive: () => {}, onError: (error) => failures.push(error.code) },
  );
  await until(async () => failures.length, Boolean);
  assert.deepEqual(failures, ['Unauthorized']);
  assert.deepEqual(calls, []);
});

test('a cancelled read frees its place on the daemon at once and the client’s once the daemon answers, and a queued reply it cancels is never sent', async (t) => {
  const { client, handlers, calls } = controlledWorkspace();
  // The host ignores the cancel: these reads never end.
  handlers.readFile = () => new Promise(() => {});
  const { endpoint } = await serve(t, controlledClient().client, { workspace: client });
  const socket = await open(t, endpoint);
  let settled = 0;
  const controllers = Array.from({ length: socketLimits.requests }, () => new AbortController());
  const reads = controllers.map((controller) =>
    socket.request('readFile', fileTarget, {
      signal: controller.signal,
      settled: () => void settled++,
    }),
  );
  await until(
    async () => calls.length,
    (count) => count === socketLimits.requests,
  );
  for (const controller of controllers) controller.abort();
  for (const read of reads) await assert.rejects(read, { code: 'Cancelled' });
  // The callers are told at once; each place is free once the daemon has answered the cancel.
  assert.equal(settled, 0);
  await until(
    async () => settled,
    (count) => count === socketLimits.requests,
  );
  // Every place on the daemon is free again although the host finished none of the reads.
  assert.equal((await socket.request('getChatHost', { host })).actorId, 'owner');

  // A reply waiting behind a large one while the client reads nothing is dropped for its cancel.
  const large = controlledWorkspace();
  large.handlers.readFile = async (input: { path: string }) => ({
    text: input.path === 'large' ? 'x'.repeat(15 * 1024 * 1024) : 'small',
    version: 'v1',
  });
  const c = await workspaceConnection(t, large.client);
  c.raw.socket.pause();
  c.send({
    type: 'request',
    id: 'large',
    operation: 'readFile',
    input: { checkout, path: 'large' },
  });
  c.send({ type: 'request', id: 'small', operation: 'readFile', input: fileTarget });
  await until(async () => c.clock.hasTimer(socketLimits.drainMs), Boolean);
  c.send({ type: 'cancel', id: 'small' });
  // Workspace replies go in order, so this one comes after anything left of the others.
  c.send({ type: 'request', id: 'after', operation: 'readFile', input: fileTarget });
  c.raw.socket.resume();
  const reassembly = new PayloadReassembly(),
    replies = new Map<
      string,
      { ok: boolean; value?: { text?: string }; error?: { code: string } }
    >(),
    order: string[] = [];
  while (!replies.has('after')) {
    const message = await readSealed(c.raw, c.keys);
    assert(message !== 'closed' && message !== 'timeout');
    if (message.type !== 'reply') continue;
    const done = reassembly.push(
      String(message.id),
      message as never,
      socketLimits.workspaceReplyBytes,
    );
    if (!done) continue;
    order.push(String(message.id));
    replies.set(String(message.id), done.value as never);
  }
  assert.equal(replies.get('small')!.error!.code, 'Cancelled');
  assert.equal(replies.get('large')!.value!.text!.length, 15 * 1024 * 1024);
  // One reply per request: the dropped one never follows.
  assert.deepEqual(order.toSorted(), ['after', 'large', 'small']);
});

test('a daemon admits each request and health probe until it is answered, past its connection, and its refusal is the reply', async (t) => {
  const source = controlledClient(),
    held = Promise.withResolvers<void>();
  source.handlers.sendChat = () => held.promise;
  let admissions = 0,
    open = 0,
    refusing = false;
  const admit = () => {
    if (refusing) throw new ApplicationError({ code: 'Unavailable', message: 'Stopping.' });
    admissions++;
    open++;
    return () => void open--;
  };
  const { endpoint, token } = await serve(t, source.client, { admit });
  const socket = await connectDaemonSocket(endpoint);
  // A mutation runs to completion after its connection closes, and stays admitted until then.
  const sending = socket
    .request('sendChat', { target, requestId: 'held', text: 'Hold this' })
    .catch(() => {});
  await until(async () => source.calls.includes('sendChat'), Boolean);
  socket.close();
  await sending;
  assert.equal(open, 1);
  held.resolve();
  await until(
    async () => open,
    (count) => count === 0,
  );
  await Effect.runPromise(checkHostHealth({ origin: endpoint.origin, token, expected: host }));
  assert.equal(admissions, 2);
  assert.equal(open, 0);

  // A refused request or probe never reaches the service.
  refusing = true;
  const before = source.calls.length;
  const second = await connectDaemonSocket(endpoint);
  t.after(() => second.close());
  await assert.rejects(second.request('getChat', { target }), { code: 'Unavailable' });
  await assert.rejects(
    Effect.runPromise(checkHostHealth({ origin: endpoint.origin, token, expected: host })),
  );
  assert.deepEqual(source.calls.slice(before), []);
});
