import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { ApplicationError } from '@moonbase/contracts/errors';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import type {
  ChatCommand,
  ChatCommands,
  ChatEntry,
  ChatListUpdate,
  ChatSnapshot,
  ChatSummary,
} from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import type { ProviderState } from '@moonbase/contracts/providers';
import {
  ChatActions,
  ChatComposers,
  ChatConnection,
  ChatDrafts,
  ChatList,
  ChatSelection,
  ChatSends,
  chatLayer,
  makeComposerChat,
  readChatState,
  type ChatDependencies,
  type ChatPort,
  type ChatServices,
  type ConnectionPort,
  type DraftStorage,
  type ProviderSetupPort,
} from '@moonbase/application/chat';

// One chat over controlled ports, for the chat's concept tests. The ports are trusted: they stand
// in for a boundary that already decoded and bounded replies.

export const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'owner' };
export const target = { ...context, conversationId: 'chat' };
export const summary: ChatSummary = {
  target,
  title: 'Saved',
  cwd: '/remote/folder',
  model: 'configured-model',
  createdAt: '2026-01-01T00:00:00Z',
};
/** A new chat's folder and model, which every host needs. */
export const settings = {
  cwd: summary.cwd,
  model: { provider: 'configured', modelId: summary.model },
};
export const snapshot: ChatSnapshot = {
  conversation: summary,
  state: 'idle',
  run: null,
  entries: [],
  olderCursor: null,
  transcriptBoundary: null,
};
export const makeEntry = (
  id: string,
  text: string,
  role: ChatEntry['role'] = 'assistant',
): ChatEntry => ({
  id,
  role,
  text,
  truncated: false,
  transcript: {
    source: { kind: 'entry', target, entryId: id },
    parts: [],
    nextCursor: null,
    thinking: 'none',
  },
});
export const profile = {
  id: 'configured',
  label: 'Configured',
  destination: 'example',
  remotePort: 9876,
  expected: context.host,
};
export const uncertain = (message = 'Controlled response loss') =>
  new ApplicationError({ code: 'Uncertain', message });
export const unavailable = (message = 'Controlled restart') =>
  new ApplicationError({ code: 'Unavailable', message });

/** Draft storage that can refuse writes. */
export class Storage implements DraftStorage {
  value: string | null = null;
  fail = false;
  writes = 0;
  /** Sees each write as it is made, before it is kept. */
  onWrite?: (value: string) => void;
  read() {
    return this.value;
  }
  write(value: string) {
    this.writes++;
    this.onWrite?.(value);
    if (this.fail) throw Error('Controlled full storage');
    this.value = value;
  }
}

/** A watch the test drives: deliver to it, fail it, see whether it closed. */
export type Watch<A> = {
  receive: (value: A) => void;
  fail: (error: unknown) => void;
  closed: boolean;
};
export const controlled = <A>(watches: Watch<A>[], opened?: (watch: Watch<A>) => void) =>
  Stream.callback<A, unknown>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watch: Watch<A> = {
          receive: (value) => void Queue.offerUnsafe(queue, value),
          fail: (error) => void Queue.failCauseUnsafe(queue, Cause.fail(error)),
          closed: false,
        };
        watches.push(watch);
        opened?.(watch);
        return watch;
      }),
      (watch) =>
        Effect.sync(() => {
          watch.closed = true;
        }),
    ),
  );

type Handler = (input: never, signal: AbortSignal) => unknown;

/** A provider setup port whose commands `answer` replies to, with a watch the test drives. */
export function providerPort(
  answer: (operation: string, input: unknown) => ProviderState | Promise<ProviderState>,
) {
  const calls: { operation: string; input: unknown }[] = [];
  const watches: Watch<ProviderState>[] = [];
  const port = new Proxy({} as ProviderSetupPort, {
    get: (_target, operation: string) =>
      operation === 'watch'
        ? () => controlled(watches)
        : (input: unknown) =>
            Effect.tryPromise({
              try: async () => {
                calls.push({ operation, input });
                return await answer(operation, input);
              },
              catch: (error) => error,
            }),
  });
  return { port, calls, watches };
}

export type ChatFixtureOptions = {
  storage?: Storage;
  /** Whether the host is reached through a connection (the default) or on this machine. */
  local?: boolean;
  /** Runs the chat on a `TestClock`, which `adjust` moves. */
  testClock?: boolean;
  dependencies?: Partial<ChatDependencies>;
};

/** One chat over controlled ports, released after the test. */
export async function chatFixture(
  t: { after: (close: () => Promise<void>) => void },
  options: ChatFixtureOptions = {},
) {
  const storage = options.storage ?? new Storage();
  const runtime = ManagedRuntime.make(
    (options.testClock ? TestClock.layer() : Layer.empty) as Layer.Layer<never>,
  );
  let connectionState: ConnectionSnapshot = { state: 'disconnected', connectionId: null, profile };
  let id = 0;
  const calls: { operation: string; input: unknown }[] = [];
  /** Replaces a command's reply: return a value, throw, or wait. */
  const answers = new Map<string, Handler>();
  /** Each command's abort signals, aborted when the chat stops waiting for it. */
  const signals = new Map<string, AbortSignal[]>();
  const chatWatches: Watch<ChatSnapshot>[] = [];
  const chatLists: Watch<ChatListUpdate>[] = [];
  const connectionWatches: Watch<ConnectionSnapshot>[] = [];
  const fallback = (operation: ChatCommand, input: unknown): unknown => {
    switch (operation) {
      case 'getChatHost':
        return { ...context, mode: 'local' };
      case 'listChats':
        return { conversations: [summary], nextCursor: null };
      case 'createChat':
        return {
          requestId: (input as ChatCommands['createChat']['input']).requestId,
          conversation: summary,
        };
      case 'getChat':
        return {
          ...structuredClone(snapshot),
          conversation: { ...summary, target: (input as { target: typeof target }).target },
        };
      case 'sendChat':
        return {
          target,
          requestId: (input as ChatCommands['sendChat']['input']).requestId,
          admission: 'admitted',
          submissionId: 'submission',
        };
      case 'getChatSend':
        return null;
      case 'stopChat':
        return { ...(input as object), outcome: 'terminal' };
      case 'settleChat':
        return { ...summary, settledAt: '2026-01-02T00:00:00Z' };
      case 'findChatFiles':
        return { query: (input as { query: string }).query, matches: [], partial: false };
      default:
        throw Error(operation);
    }
  };
  const command = (operation: string, input: unknown, run: () => unknown) =>
    Effect.tryPromise({
      try: async (signal) => {
        signals.set(operation, [...(signals.get(operation) ?? []), signal]);
        calls.push({ operation, input: structuredClone(input) });
        const handler = answers.get(operation);
        return handler ? await handler(input as never, signal) : run();
      },
      catch: (error) => error,
    });
  const chat = new Proxy({} as ChatPort, {
    get: (_target, operation: string) => {
      if (operation === 'watch') return () => controlled(chatWatches);
      if (operation === 'watchChatList') return () => controlled(chatLists);
      return (input: unknown) =>
        command(operation, input, () => fallback(operation as ChatCommand, input));
    },
  });
  const connection = {
    getConnection: (input: unknown) => command('getConnection', input, () => connectionState),
    connect: (input: unknown) =>
      command('connect', input, () => {
        connectionState = connected('generation-' + ++id);
        for (const watch of connectionWatches) if (!watch.closed) watch.receive(connectionState);
        return connectionState;
      }),
    disconnect: (input: unknown) =>
      command('disconnect', input, () => {
        connectionState = { state: 'disconnected', connectionId: null, profile };
        for (const watch of connectionWatches) if (!watch.closed) watch.receive(connectionState);
      }),
    watch: () => controlled(connectionWatches),
  } as unknown as ConnectionPort;
  const dependencies = (overrides?: Partial<ChatDependencies>): ChatDependencies => ({
    chat,
    ...(options.local ? {} : { connection }),
    context,
    storage,
    newId: () => `request-${++id}`,
    ...options.dependencies,
    ...overrides,
  });

  const open = async (overrides?: Partial<ChatDependencies>) => {
    const scope = Scope.makeUnsafe();
    const services = await runtime.runPromise(
      Layer.buildWithScope(chatLayer(dependencies(overrides)), scope),
    );
    // Made after the chat in its scope, as `ChatHost` does, so it closes first.
    const composer = await runtime.runPromise(
      Effect.flatMap(ChatComposers, (composers) => composers.make(makeComposerChat(services))).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(ChatComposers.layer),
      ),
    );
    return { scope, services, composer };
  };
  let current = await open();
  const closed = new Set<Scope.Closeable>();
  const closeChat = async () => {
    if (closed.has(current.scope)) return;
    closed.add(current.scope);
    await runtime.runPromise(Scope.close(current.scope, Exit.void));
  };
  t.after(async () => {
    await closeChat();
    await runtime.dispose();
  });

  /** Runs `effect` against the chat's services. */
  const run = <A, E = never>(effect: Effect.Effect<A, E, ChatServices>): Promise<A> =>
    runtime.runPromise(Effect.provideContext(effect, current.services));
  const service = <I, S>(tag: Context.Key<I, S>) => Context.get(current.services as never, tag);
  /** The chat's composer, made in its scope beside it. */
  const composer = () => current.composer;

  /** The chat's actions, as a view calls them; each resolves when the action settles. */
  const actions = {
    start: () => run(Effect.flatMap(ChatConnection, (c) => c.start)),
    connect: () => run(Effect.flatMap(ChatConnection, (c) => c.connect)),
    disconnect: () => run(Effect.flatMap(ChatConnection, (c) => c.disconnect)),
    refresh: () => run(Effect.flatMap(ChatConnection, (c) => c.refresh)),
    select: (to = target) => run(Effect.flatMap(ChatSelection, (s) => s.select(to))),
    closeView: () => run(Effect.flatMap(ChatSelection, (s) => s.closeView)),
    setDraft: (value: string, mentions?: { path: string }[]) =>
      run(Effect.flatMap(ChatDrafts, (d) => d.setDraft(value, mentions))),
    setModelPreference: (value: Parameters<ChatDrafts['Service']['setModelPreference']>[0]) =>
      run(Effect.flatMap(ChatDrafts, (d) => d.setModelPreference(value))),
    markSeen: (conversationId: string, at: string) =>
      run(Effect.flatMap(ChatDrafts, (d) => d.markSeen(conversationId, at))),
    preserve: () => run(Effect.flatMap(ChatDrafts, (d) => d.preserve)),
    send: (with_?: typeof settings) => run(Effect.flatMap(ChatSends, (s) => s.send(with_))),
    create: (title: string, with_?: typeof settings) =>
      run(Effect.flatMap(ChatSends, (s) => s.create(title, with_))),
    stop: () => run(Effect.flatMap(ChatSends, (s) => s.stop)),
    retry: (requestId: string) => run(Effect.flatMap(ChatSends, (s) => s.retry(requestId))),
    query: (requestId: string) => run(Effect.flatMap(ChatSends, (s) => s.query(requestId))),
    moreChats: () => run(Effect.flatMap(ChatList, (l) => l.more)),
    reloadChats: (latest = false) => run(Effect.flatMap(ChatList, (l) => l.reload({ latest }))),
    watchChats: () => run(Effect.flatMap(ChatList, (l) => l.watch)),
    settle: (to: typeof target, settled: boolean) =>
      run(Effect.flatMap(ChatList, (l) => l.settle(to, settled))),
    setAdmissionsOpen: (open: boolean) =>
      run(Effect.flatMap(ChatActions, (a) => a.setAdmissionsOpen(open))),
  };

  return {
    ...actions,
    run,
    service,
    /** The chat's services, as views read them. */
    services: () => current.services,
    composer,
    runtime,
    storage,
    calls,
    answers,
    signals,
    chatWatches,
    chatLists,
    connectionWatches,
    /** The chat's state now. */
    state: () => run(readChatState),
    /** Delivers a snapshot to the newest open chat watch. */
    publish: (value: ChatSnapshot) =>
      chatWatches.findLast((watch) => !watch.closed)?.receive(value),
    /** Delivers a connection state to the open connection watches. */
    publishConnection: (value: ConnectionSnapshot) => {
      connectionState = value;
      for (const watch of connectionWatches) if (!watch.closed) watch.receive(value);
    },
    /** How many chat watches are open. */
    get subscriptions() {
      return chatWatches.filter((watch) => !watch.closed).length;
    },
    /** Moves the `TestClock`. */
    adjust: (millis: number) => runtime.runPromise(TestClock.adjust(millis)),
    /** Closes this chat (as the application releases it). */
    close: closeChat,
    /** How many times the chat sent `operation`. */
    count: (operation: string) => calls.filter((call) => call.operation === operation).length,
    /** Closes this chat and opens another over the same ports and storage (`overrides` replace some). */
    reopen: async (overrides?: Partial<ChatDependencies>) => {
      await closeChat();
      current = await open(overrides);
    },
  };
}
export type ChatFixture = Awaited<ReturnType<typeof chatFixture>>;

/** Lets the chat's fibers run to their next wait. */
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Starts, connects and opens the saved chat, once its first snapshot shows. */
export async function openChat(f: ChatFixture, to = target) {
  await f.start();
  await f.connect();
  await f.select(to);
  await until(
    f,
    (state) =>
      state.ready && state.snapshot?.conversation.target.conversationId === to.conversationId,
  );
}

/** Waits until `check` holds, failing after many turns. */
export async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await turn();
  }
  throw Error('The expected condition never held.');
}

/** The open chat running a task that `stop` names. */
export const running = (
  stop: { target: typeof target; submissionId: string; taskId: string | null } = {
    target,
    submissionId: 'one',
    taskId: 'task',
  },
): ChatSnapshot => ({
  ...snapshot,
  state: 'running',
  run: { state: 'running', stop, text: '', truncated: false },
});

/** A connected state of generation `connectionId`. */
export const connected = (connectionId: string): ConnectionSnapshot => ({
  state: 'connected',
  connectionId,
  profile,
  health: {
    ...context.host,
    protocol: chatProtocolVersion,
    version: '0.1.0',
    capabilities: ['chat-v0'],
  },
});

/** Waits until `check` holds for the chat's state, failing after many turns. */
export async function until(
  f: ChatFixture,
  check: (state: Awaited<ReturnType<ChatFixture['state']>>) => boolean,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await f.state();
    if (check(state)) return state;
    await turn();
  }
  throw Error('The chat never reached the expected state.');
}
