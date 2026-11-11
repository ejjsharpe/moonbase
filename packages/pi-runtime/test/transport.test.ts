import type { ConversationId, Harness as HarnessType } from '@earendil-works/pi-durable';
import type { ChatInput, ChatStopTarget } from '@moonbase/contracts/chat';
import { daemonErrorReasons, type DaemonClient } from '@moonbase/contracts/daemon';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient, makeProviderSetupClient } from '@moonbase/application/runtime/clients';
import {
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatClient } from '@moonbase/contracts/chat';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import { LocalHostLive, LocalPiRuntimeLive } from '../src/index.ts';
import { createFolderApprovals } from '../src/folders.ts';
import { ProviderSetupLive, localProviderIds } from '../src/providers.ts';
import { RemoteChatLive, RemoteLocalHostLive, RemoteProviderSetupLive } from '../src/remote.ts';
import { makeDaemonClient, serveChat } from '../src/server.ts';
import { connectDaemonSocket } from '../src/socket-client.ts';

const host = { hostId: 'transport-host', storeId: 'transport-store' },
  session = { host, actorId: 'personal' },
  health = {
    ...host,
    protocol: 2 as const,
    version: '0.1.0' as const,
    capabilities: ['chat-v0', 'daemon-local-v1'],
  };
const nonce = () => randomBytes(32).toString('base64url');
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-http-'))),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 }),
    token = nonce();
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      databasePath: join(dir, 'chat.sqlite'),
      models,
      // A chat may search only this folder before it exists.
      approveFolder: async (cwd) => {
        if (cwd !== dir)
          throw new ApplicationError({ code: 'Unauthorized', message: 'Approve this folder.' });
      },
    }),
  );
  const settings = { cwd: dir, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
  // Chat is the subject here; the host serves no other daemon operation.
  const daemon: DaemonClient = {
    command: async () => {
      throw new ApplicationError({ code: 'Unavailable', message: 'Not served here.' });
    },
  };
  const client = makeChatClient(runtime),
    calls: string[] = [];
  let intercept: ((operation: string, signal?: AbortSignal) => Promise<void>) | undefined,
    afterDispatch: ((operation: string) => Promise<void>) | undefined;
  const bound: ChatClient = {
    command: async (operation, input, options) => {
      calls.push(operation);
      await intercept?.(operation, options?.signal);
      const value = await client.command(operation, input, options);
      await afterDispatch?.(operation);
      return value;
    },
    watch: client.watch,
    watchChatList: client.watchChatList,
  };
  let scope = Effect.runSync(Scope.make());
  let server = await runtime.runPromise(
    serveChat({ host, token, port: 0 }, bound, daemon, [chatHostCapabilities.local]).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  let endpoint: VerifiedChatEndpoint = {
    origin: server.origin,
    token,
    expected: host,
    connectionId: 'one',
    health,
  };
  let available = true;
  const unavailable = () =>
    Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Disconnected' }));
  const connections = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    watch: () => Stream.empty,
    endpoint: ({ host: expected }) =>
      Effect.suspend(() =>
        available && expected.hostId === host.hostId && expected.storeId === host.storeId
          ? Effect.succeed(structuredClone(endpoint))
          : unavailable(),
      ),
  });
  const remoteRuntime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connections))),
    remote = makeChatClient(remoteRuntime);
  t.after(async () => {
    await remoteRuntime.dispose();
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    settings,
    client,
    remote,
    faux,
    token,
    calls,
    get origin() {
      return server.origin;
    },
    set intercept(value: typeof intercept) {
      intercept = value;
    },
    set afterDispatch(value: typeof afterDispatch) {
      afterDispatch = value;
    },
    set endpoint(value: VerifiedChatEndpoint) {
      endpoint = value;
    },
    get endpoint() {
      return endpoint;
    },
    disconnect() {
      available = false;
    },
    reconnect() {
      available = true;
      endpoint = { ...endpoint, connectionId: nonce() };
    },
    async restartServer() {
      await runtime.runPromise(Scope.close(scope, Exit.void));
      scope = Effect.runSync(Scope.make());
      server = await runtime.runPromise(
        serveChat({ host, token, port: 0 }, bound, daemon, [chatHostCapabilities.local]).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      endpoint = { ...endpoint, origin: server.origin, connectionId: 'two' };
    },
  };
}
test('a host refuses to serve when its public configuration repeats its private key', async () => {
  const token = nonce(),
    scope = Effect.runSync(Scope.make());
  const client: ChatClient = {
    command: async (operation) => {
      if (operation !== 'getChatHost') throw Error('Unexpected ' + operation);
      return { host, actorId: token, mode: 'local' } as never;
    },
    watch: () => async () => {},
    watchChatList: () => async () => {},
  };
  try {
    await assert.rejects(
      Effect.runPromise(
        serveChat({ host, token, port: 0 }, client).pipe(Effect.provideService(Scope.Scope, scope)),
      ),
      (error: unknown) =>
        ApplicationError.is(error) &&
        error.code === 'InvalidInput' &&
        !error.message.includes(token),
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
test('production remote/server route shared commands and immutable retries without key disclosure', async (t) => {
  const f = await setup(t);
  assert.deepEqual(
    await f.remote.command('getChatHost', { host }),
    await f.client.command('getChatHost', { host }),
  );
  const created = await f.remote.command('createChat', {
      session,
      requestId: 'create',
      title: 'Remote saved',
      settings: f.settings,
    }),
    target = created.conversation.target;
  f.faux.setResponses([fauxAssistantMessage('Reply')]);
  const input = { target, requestId: 'send', text: 'Private prompt' };
  const first = await f.remote.command('sendChat', input);
  assert.deepEqual(await f.remote.command('sendChat', input), first);
  await assert.rejects(f.remote.command('sendChat', { ...input, text: 'Changed' }), {
    code: 'InvalidInput',
  });
  assert.deepEqual(await f.remote.command('getChatSend', { target, requestId: 'send' }), first);
  const view = await f.remote.command('getChat', { target });
  assert(!JSON.stringify(view).includes(f.token));
  assert.equal(f.faux.state.callCount, 1);
  f.disconnect();
  const count = f.calls.length;
  await assert.rejects(f.remote.command('getChat', { target }), { code: 'Unavailable' });
  assert.equal(f.calls.length, count);
});
test('signed malformed-reply errors consistently report Incompatible without rejected values', async (t) => {
  const f = await setup(t);
  const { conversation } = await f.client.command('createChat', {
    session,
    requestId: 'malformed-reply',
    title: 'Saved chat',
    settings: f.settings,
  });
  const command = f.client.command.bind(f.client);
  let reply: unknown;
  t.mock.method(f.client, 'command', async (...args: Parameters<ChatClient['command']>) =>
    args[0] === 'listChats' ? (reply as never) : command(...args),
  );
  const secret = 'synthetic-private-value-not-for-errors';
  for (const changed of [
    { title: 1 },
    { target: { ...conversation.target, actorId: secret + ' invalid' } },
    { cwd: { secret } },
    { createdAt: 'invalid date' },
  ] as const) {
    reply = { conversations: [{ ...conversation, ...changed }], nextCursor: null };
    await assert.rejects(f.remote.command('listChats', { session }), (error: unknown) => {
      assert(error instanceof ApplicationError);
      assert.equal(error.code, 'Incompatible');
      assert(!String(error).includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      return true;
    });
  }
});
test('remote drops successful and error responses from a stale connection generation', async (t) => {
  const f = await setup(t);
  let release!: () => void;
  let entered!: () => void;
  for (const failed of [false, true]) {
    const gate = new Promise<void>((r) => (release = r)),
      waiting = new Promise<void>((r) => (entered = r));
    f.intercept = async (operation) => {
      if (operation === 'listChats') {
        entered();
        await gate;
        if (failed) throw new ApplicationError({ code: 'Conflict', message: 'Private detail' });
      }
    };
    const call = f.remote.command('listChats', { session });
    await waiting;
    f.endpoint = { ...f.endpoint, connectionId: nonce() };
    release();
    await assert.rejects(call, { code: 'Unavailable' });
  }
  f.intercept = undefined;
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  for (const loss of ['disconnect', 'replacement'] as const)
    test(
      `R3 ${operation} generation ${loss} after dispatch preserves uncertainty and original identity`,
      { timeout: 10000 },
      async (t) => {
        const f = await setup(t);
        let release = () => {},
          releaseModel = () => {},
          entered = () => {};
        const held = new Promise<void>((resolve) => (release = resolve)),
          admitted = new Promise<void>((resolve) => (entered = resolve));
        t.signal.addEventListener(
          'abort',
          () => {
            release();
            releaseModel();
          },
          { once: true },
        );
        try {
          const target =
            operation === 'createChat'
              ? undefined
              : (
                  await f.remote.command('createChat', {
                    session,
                    requestId: 'setup',
                    title: 'Existing',
                    settings: f.settings,
                  })
                ).conversation.target;
          let stop: ChatStopTarget | undefined;
          if (operation === 'stopChat') {
            const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
            f.faux.setResponses([
              async () => {
                await modelGate;
                return fauxAssistantMessage('Stopped work');
              },
            ]);
            await f.remote.command('sendChat', {
              target: target!,
              requestId: 'setup-send',
              text: 'Held work',
            });
            for (let i = 0; i < 100; i++) {
              const state = await f.client.command('getChat', { target: target! });
              if (state.run?.stop.taskId && f.faux.state.callCount === 1) {
                stop = state.run.stop;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(stop, 'a captured actual task is required');
          } else f.faux.setResponses([fauxAssistantMessage('Saved once')]);
          f.afterDispatch = async (name) => {
            if (name === operation) {
              entered();
              await held;
            }
          };
          let input;
          if (operation === 'createChat') {
            input = {
              session,
              requestId: 'original-create',
              title: 'Captured create',
              settings: f.settings,
            };
          } else {
            if (operation === 'sendChat') {
              input = { target: target!, requestId: 'original-send', text: 'Captured Send' };
            } else {
              input = { stop: stop!, requestId: 'original-stop' };
            }
          }
          const pending = f.remote.command(operation, input);
          await admitted;
          if (loss === 'disconnect') f.disconnect();
          else f.endpoint = { ...f.endpoint, connectionId: nonce() };
          release();
          await assert.rejects(pending, { code: 'Uncertain' });
          f.afterDispatch = undefined;
          f.reconnect();
          assert.equal(f.calls.filter((name) => name === operation).length, 1);
          if (operation === 'createChat') {
            const saved = await f.client.command('listChats', { session });
            assert.equal(saved.conversations.length, 1);
            const retry = await f.remote.command('createChat', input as ChatInput<'createChat'>);
            assert.deepEqual(retry.conversation.target, saved.conversations[0].target);
          } else if (operation === 'sendChat') {
            const receipt = await f.remote.command('getChatSend', {
              target: target!,
              requestId: input.requestId,
            });
            assert.equal(receipt?.admission, 'admitted');
            assert.deepEqual(
              await f.remote.command('sendChat', input as ChatInput<'sendChat'>),
              receipt,
            );
            assert.equal(f.faux.state.callCount, 1);
          } else {
            const retry = await f.remote.command('stopChat', input as ChatInput<'stopChat'>);
            assert.deepEqual(retry.stop, stop);
            assert.equal(f.faux.state.callCount, 1);
          }
        } finally {
          release();
          releaseModel();
          f.afterDispatch = undefined;
        }
      },
    );

test('a lost Send acknowledgement resolves through reconnect lookup without another model call', async (t) => {
  const f = await setup(t),
    target = (
      await f.remote.command('createChat', {
        session,
        requestId: 'create',
        title: 'Lost reply',
        settings: f.settings,
      })
    ).conversation.target;
  f.faux.setResponses([fauxAssistantMessage('Only once')]);
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const abort = new AbortController();
  f.afterDispatch = async (operation) => {
    if (operation === 'sendChat') {
      entered();
      await gate;
    }
  };
  try {
    const input = { target, requestId: 'send', text: 'Original pending input' },
      pending = f.remote.command('sendChat', input, { signal: abort.signal });
    await admitted;
    abort.abort();
    await assert.rejects(pending, { code: 'Cancelled' });
    release();
    f.afterDispatch = undefined;
    f.endpoint = { ...f.endpoint, connectionId: 'reconnected' };
    const receipt = await f.remote.command('getChatSend', { target, requestId: 'send' });
    assert.equal(receipt?.admission, 'admitted');
    assert.deepEqual(await f.remote.command('sendChat', input), receipt);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    abort.abort();
    release();
    f.afterDispatch = undefined;
  }
});
test('authenticated file search reaches the host and refuses another folder', async (t) => {
  const f = await setup(t);
  // Git lists the folder whether or not this machine has ripgrep.
  execFileSync('git', ['init', '-q'], { cwd: f.dir });
  const found = await f.remote.command('findChatFiles', {
    session,
    cwd: f.dir,
    query: 'chatsqlite',
  });
  assert.equal(found.matches[0]?.path, 'chat.sqlite');
  await assert.rejects(f.remote.command('findChatFiles', { session, cwd: '/', query: '' }), {
    code: 'Unauthorized',
  });
});

test('authenticated settling reaches the remote host, and a lost reply is uncertain', async (t) => {
  const f = await setup(t);
  const target = (
    await f.remote.command('createChat', {
      session,
      requestId: 'c',
      title: 'Remote',
      settings: f.settings,
    })
  ).conversation.target;
  const settled = await f.remote.command('settleChat', { target, settled: true });
  assert(settled.settledAt);
  assert.equal(
    (await f.client.command('getChat', { target })).conversation.settledAt,
    settled.settledAt,
  );
  assert.equal(
    (await f.remote.command('settleChat', { target, settled: false })).settledAt,
    undefined,
  );
  f.afterDispatch = async (operation) => {
    if (operation === 'settleChat') f.disconnect();
  };
  await assert.rejects(f.remote.command('settleChat', { target, settled: true }), {
    code: 'Uncertain',
  });
});

test('authenticated Find transports saved matches, rejects foreign continuations and cancels peer waits', async (t) => {
  const f = await setup(t);
  const target = (
    await f.remote.command('createChat', {
      session,
      requestId: 'create',
      title: 'Find fixture',
      settings: f.settings,
    })
  ).conversation.target;
  await f.remote.command('sendChat', {
    target,
    requestId: 'send',
    text: 'Retained Σ literal [.*]',
  });
  const first = await f.remote.command('findChatTranscript', { target, query: 'σ' });
  assert.equal(
    first.matches[0].snippet.text.slice(
      first.matches[0].start - first.matches[0].snippet.start,
      first.matches[0].end - first.matches[0].snippet.start,
    ),
    'Σ',
  );
  assert.deepEqual(
    (
      await f.remote.command('findChatTranscript', {
        target,
        query: 'σ',
        cursor: first.startCursor,
      })
    ).matches,
    first.matches,
  );
  await assert.rejects(
    f.remote.command('findChatTranscript', {
      target,
      query: 'different',
      cursor: first.startCursor,
    }),
    { code: 'InvalidInput' },
  );
  await assert.rejects(
    f.remote.command('findChatTranscript', {
      target: { ...target, actorId: 'foreign' },
      query: 'σ',
    }),
  );
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  let peerSignal: AbortSignal | undefined;
  f.intercept = async (operation, signal) => {
    if (operation === 'findChatTranscript') {
      peerSignal = signal;
      entered = true;
      await gate;
    }
  };
  const abort = new AbortController();
  const pending = f.remote.command(
    'findChatTranscript',
    { target, query: 'literal' },
    { signal: abort.signal },
  );
  const rejected = assert.rejects(pending, { code: 'Cancelled' });
  for (let i = 0; i < 100 && !entered; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(entered);
  abort.abort();
  await rejected;
  for (let i = 0; i < 100 && !peerSignal?.aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert(peerSignal?.aborted);
  assert.equal(
    (await f.remote.command('getChat', { target })).conversation.target.conversationId,
    target.conversationId,
  );
  release();
});

test('authenticated Find and around-entry navigation reach all 1,100 retained rows across a fixed replay cutoff', async (t) => {
  const { Harness } = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  let harness!: HarnessType;
  const open = Harness.open;
  t.mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof open>) => (harness = await open(...args)),
  );
  const f = await setup(t);
  const target = (
    await f.remote.command('createChat', {
      session,
      requestId: 'large-find',
      title: 'Retained Find navigation',
      settings: f.settings,
    })
  ).conversation.target;
  const ids = await harness.commit(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const text = [0, 550, 1099].includes(i) ? `landmark ${i} Σ` : `ordinary ${i}`;
      const entry = await tx.appendEntry(
        Number(target.conversationId) as ConversationId,
        i % 3 === 0
          ? {
              kind: 'pi.assistant',
              model: [fauxAssistantMessage([{ type: 'thinking', thinking: text }])],
            }
          : { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 1 }] },
      );
      ids.push(String(entry.id));
    }
    return ids;
  }, BACKGROUND_CONTEXT);
  async function scan(cursor?: string) {
    const matches = [];
    let start = '',
      upper: string | null = null,
      empty = false;
    do {
      const page = await f.remote.command('findChatTranscript', {
        target,
        query: 'LANDMARK',
        ...(cursor ? { cursor } : {}),
      });
      if (start) assert.equal(page.startCursor, start);
      start = page.startCursor;
      upper = page.upperEntryId;
      matches.push(...page.matches);
      empty ||= !page.matches.length && page.nextCursor !== null;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { matches, start, upper, empty };
  }
  const first = await scan();
  assert(first.empty);
  assert.deepEqual(
    first.matches.map((match) => match.source.entryId),
    [ids[0], ids[550], ids[1099]],
  );
  for (const match of first.matches) {
    const around = await f.remote.command('getChatHistoryAround', {
      target,
      entryId: match.source.entryId,
    });
    assert(around.entries.some((entry) => entry.id === match.source.entryId));
    for (const cursor of [around.olderCursor, around.newerCursor])
      if (cursor) {
        const next = await f.remote.command('getChatHistoryAround', {
          target,
          entryId: match.source.entryId,
          cursor,
        });
        assert.equal(next.upperEntryId, around.upperEntryId);
        assert(!next.entries.some((entry) => around.entries.some((old) => old.id === entry.id)));
      }
  }
  await harness.commit(
    (tx) =>
      tx.appendEntry(Number(target.conversationId) as ConversationId, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'LANDMARK appended', timestamp: 1 }],
      }),
    BACKGROUND_CONTEXT,
  );
  assert.deepEqual((await scan(first.start)).matches, first.matches);
  assert.equal((await scan()).matches.length, 4);
  await assert.rejects(f.remote.command('getChatHistoryAround', { target, entryId: '999999999' }), {
    code: 'InvalidInput',
  });
  const other = (
    await f.remote.command('createChat', {
      session,
      requestId: 'other-find',
      title: 'Other',
      settings: f.settings,
    })
  ).conversation.target;
  await assert.rejects(
    f.remote.command('findChatTranscript', {
      target: other,
      query: 'LANDMARK',
      cursor: first.start,
    }),
    { code: 'InvalidInput' },
  );
});

// Local-mode daemon operations: folders, control and provider setup over the same protocol.
const localHost = { hostId: 'daemon-host', storeId: 'daemon-store' },
  localSession = { host: localHost, actorId: 'daemon-owner' },
  daemonCapabilities = ['chat-v0', 'daemon-local-v1', 'providers-v1', 'folders-v1'];
const signInUrl = 'https://auth.openai.com/api/accounts/authorize?state=controlled';
async function setupLocal(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-http-'))),
    token = nonce(),
    models = createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    }),
    faux = fauxProvider({ provider: 'local-faux', models: [{ id: 'local-model' }] });
  models.setProvider(faux.provider);
  const state = { url: signInUrl };
  for (const id of localProviderIds) {
    const provider = fauxProvider({ provider: id }).provider;
    const auth = (): typeof provider.auth => {
      if (id === 'claude-code') return {};
      if (id !== 'openai')
        return {
          apiKey: {
            name: 'API key',
            login: async (interaction) => ({
              type: 'api_key',
              key: await interaction.prompt({ type: 'secret', message: 'Enter API key' }),
            }),
            resolve: async ({ credential }) =>
              credential?.key ? { auth: { apiKey: credential.key } } : undefined,
          },
        };
      return {
        oauth: {
          name: 'Controlled ChatGPT',
          login: async (interaction) => {
            interaction.notify({ type: 'auth_url', url: state.url });
            const code = await interaction.prompt({ type: 'manual_code', message: 'Code' });
            if (code !== 'redirect-code') throw Error('Refused');
            return {
              type: 'oauth',
              access: 'private-access',
              refresh: 'private-refresh',
              expires: Date.now() + 60000,
            };
          },
          refresh: async () => {
            throw Error('No refresh');
          },
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      };
    };
    models.setProvider({
      ...provider,
      name: id,
      auth: auth(),
    });
  }
  const folders = createFolderApprovals(join(dir, 'approved-folders.json')),
    chatFolders = join(dir, 'chats');
  const requireApproved = async (path: string) => {
    if (!(await folders.has(path)))
      throw new ApplicationError({ code: 'Unauthorized', message: 'Approve this folder.' });
  };
  const local = LocalPiRuntimeLive({
    ...localSession,
    databasePath: join(dir, 'chat.sqlite'),
    chatFolders,
    models,
    approveCreation: async (settings) => {
      if (settings.cwd !== undefined) await requireApproved(settings.cwd);
    },
    approveFolder: requireApproved,
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      LocalHostLive({ host: localHost, folders, chatFolders }).pipe(Layer.provideMerge(local)),
      ProviderSetupLive({ models, deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }),
    ),
  );
  const client = makeChatClient(runtime),
    daemonClient = makeDaemonClient(runtime),
    dispatched: string[] = [];
  let afterDispatch: ((operation: string) => Promise<void>) | undefined;
  const daemon: DaemonClient = {
    command: async (operation, input, options) => {
      dispatched.push(operation);
      const value = await daemonClient.command(operation, input, options);
      await afterDispatch?.(operation);
      return value;
    },
  };
  const scope = Effect.runSync(Scope.make());
  const server = await runtime.runPromise(
    serveChat({ host: localHost, token, port: 0 }, client, daemon).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  let endpoint: VerifiedChatEndpoint = {
    origin: server.origin,
    token,
    expected: localHost,
    connectionId: 'local-one',
    health: { ...localHost, protocol: 2, version: '0.1.0', capabilities: daemonCapabilities },
  };
  const unavailable = () =>
    Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Disconnected' }));
  const connections = Layer.succeed(ConnectionService, {
    getConnection: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    watch: () => Stream.empty,
    endpoint: () => Effect.sync(() => structuredClone(endpoint)),
  });
  const opened: string[] = [];
  const remoteRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteChatLive,
      RemoteLocalHostLive,
      RemoteProviderSetupLive({
        host: localHost,
        sameMachine: true,
        openUrl: async (url) => {
          opened.push(url);
        },
      }),
    ).pipe(Layer.provide(connections)),
  );
  t.after(async () => {
    await remoteRuntime.dispose();
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const localHostService = await remoteRuntime.runPromise(LocalHostService),
    providers = await remoteRuntime.runPromise(ProviderSetupService);
  return {
    dir,
    token,
    faux,
    state,
    opened,
    dispatched,
    origin: server.origin,
    remote: makeChatClient(remoteRuntime),
    host: <A>(effect: Effect.Effect<A, ApplicationError>) => remoteRuntime.runPromise(effect),
    folders: localHostService,
    providers,
    owner: (ownerId: string) => makeProviderSetupClient(remoteRuntime, ownerId),
    set afterDispatch(value: typeof afterDispatch) {
      afterDispatch = value;
    },
    reconnect() {
      endpoint = { ...endpoint, connectionId: nonce() };
    },
  };
}
async function untilState<A>(read: () => Promise<A>, ready: (value: A) => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('State did not settle');
}

test('provider setup runs over the protocol per owner, returns validated sign-in links and never resends', async (t) => {
  const f = await setupLocal(t);
  const a = f.owner('document-a'),
    b = f.owner('document-b');
  assert.equal((await a.command('getProviders', {})).flow, null);
  const started = await a.command('startProviderLogin', { providerId: 'openai' });
  const flowId = started.flow!.id;
  const ready = await untilState(
    () => a.command('getProviders', {}),
    (state) => !!state.flow?.canOpenUrl && state.flow.prompt?.type === 'manual_code',
  );
  // On the daemon's machine the loopback callback finishes sign-in; the prompt says so.
  assert.match(ready.flow!.prompt!.message, /completes it by itself/);
  assert.equal(await f.host(f.providers.getProviderUrl('document-a', flowId)), signInUrl);
  assert.deepEqual(f.opened, []);
  await a.command('openProviderUrl', { flowId });
  assert.deepEqual(f.opened, [signInUrl]);
  // Another owner sees no flow and cannot answer, open or cancel this one.
  assert.equal((await b.command('getProviders', {})).flow, null);
  for (const [operation, input] of [
    ['answerProviderPrompt', { flowId, promptId: ready.flow!.prompt!.id, answer: 'redirect-code' }],
    ['openProviderUrl', { flowId }],
    ['cancelProviderLogin', { flowId }],
  ] as const)
    await assert.rejects(b.command(operation, input as never), (error: ApplicationError) => {
      assert.equal(error.code, 'InvalidInput');
      assert(!error.message.includes(flowId));
      return true;
    });
  assert.deepEqual(f.opened, [signInUrl]);
  await a.command('answerProviderPrompt', {
    flowId,
    promptId: ready.flow!.prompt!.id,
    answer: 'redirect-code',
  });
  const done = await untilState(
    () => a.command('getProviders', {}),
    (state) => state.flow?.state === 'completed',
  );
  assert.equal(done.providers.find((provider) => provider.id === 'openai')?.configured, true);
  assert(!/private-(?:access|refresh)|redirect-code/.test(JSON.stringify(done)));
  const key = await b.command('startProviderLogin', { providerId: 'anthropic' });
  const prompt = (
    await untilState(
      () => b.command('getProviders', {}),
      (state) => !!state.flow?.prompt,
    )
  ).flow!.prompt!;
  await b.command('answerProviderPrompt', {
    flowId: key.flow!.id,
    promptId: prompt.id,
    answer: 'private-key',
  });
  await untilState(
    () => b.command('getProviders', {}),
    (state) => state.providers.find((provider) => provider.id === 'anthropic')!.configured,
  );
  const out = await b.command('logoutProvider', { providerId: 'anthropic' });
  assert.equal(out.providers.find((provider) => provider.id === 'anthropic')?.configured, false);
  const cancelled = await b.command('startProviderLogin', { providerId: 'google' });
  assert.equal(
    (await b.command('cancelProviderLogin', { flowId: cancelled.flow!.id })).flow?.state,
    'cancelled',
  );
  await f.host(f.providers.releaseOwner('document-a'));
  await assert.rejects(a.command('startProviderLogin', { providerId: 'openai' }), {
    code: 'InvalidInput',
  });
  // A lost reply to a mutation is Uncertain, and the mutation was dispatched exactly once.
  f.afterDispatch = async (operation) => {
    if (operation === 'startProviderLogin') f.reconnect();
  };
  const before = f.dispatched.length;
  await assert.rejects(b.command('startProviderLogin', { providerId: 'openrouter' }), {
    code: 'Uncertain',
  });
  assert.deepEqual(f.dispatched.slice(before), ['startProviderLogin']);
  f.afterDispatch = async (operation) => {
    if (operation === 'getProviders') f.reconnect();
  };
  await assert.rejects(b.command('getProviders', {}), { code: 'Unavailable' });
  f.afterDispatch = undefined;
});

test('a provider sign-in URL outside the expected origins never reaches the client', async (t) => {
  const f = await setupLocal(t);
  const a = f.owner('document-a');
  for (const url of [
    'https://auth.openai.com.example/authorize',
    'http://auth.openai.com/authorize',
    'https://user:pass@auth.openai.com/authorize',
    'https://auth.openai.com:8443/authorize',
    'javascript:alert(1)',
  ]) {
    f.state.url = url;
    const started = await a.command('startProviderLogin', { providerId: 'openai' });
    const failed = await untilState(
      () => a.command('getProviders', {}),
      (state) => state.flow?.state === 'failed',
    );
    assert.equal(failed.flow!.canOpenUrl, false);
    assert(!JSON.stringify(failed).includes(url));
    await assert.rejects(a.command('openProviderUrl', { flowId: started.flow!.id }), {
      code: 'InvalidInput',
    });
  }
  assert.deepEqual(f.opened, []);
});

test('a folder approval is re-checked by identity on use; a replaced folder needs a new grant', async (t) => {
  const f = await setupLocal(t);
  const folder = join(f.dir, 'replaced');
  await mkdir(folder);
  await f.host(f.folders.approveFolder({ host: localHost, requestId: 'grant-1', path: folder }));
  const create = (requestId: string) =>
    f.remote.command('createChat', {
      session: localSession,
      requestId,
      title: 'Replaced',
      settings: { cwd: folder, model: { provider: 'local-faux', modelId: 'local-model' } },
    });
  await create('before-move');
  await rename(folder, join(f.dir, 'moved'));
  await mkdir(folder);
  await assert.rejects(create('after-move'), { code: 'Unauthorized' });
  await assert.rejects(
    f.remote.command('findChatFiles', { session: localSession, cwd: folder, query: '' }),
    { code: 'Unauthorized' },
  );
  assert.deepEqual((await f.host(f.folders.listRecentFolders({ host: localHost }))).folders, []);
  await assert.rejects(
    f.host(
      f.folders.approveFolder({
        host: localHost,
        requestId: 'missing',
        path: join(f.dir, 'missing'),
      }),
    ),
    { code: 'InvalidInput' },
  );
  await f.host(f.folders.approveFolder({ host: localHost, requestId: 'grant-2', path: folder }));
  await create('after-grant');
  // A lost reply to an approval is Uncertain and is not sent again.
  f.afterDispatch = async (operation) => {
    if (operation === 'approveFolder') f.reconnect();
  };
  const before = f.dispatched.length;
  await assert.rejects(
    f.host(f.folders.approveFolder({ host: localHost, requestId: 'grant-3', path: folder })),
    { code: 'Uncertain' },
  );
  assert.deepEqual(f.dispatched.slice(before), ['approveFolder']);
  f.afterDispatch = undefined;
});

test('a refused daemon mutation may be sent again; one that may have applied is never rerun', async (t) => {
  const f = await setupLocal(t);
  const folder = join(f.dir, 'later');
  const socket = await connectDaemonSocket({
    origin: f.origin,
    token: f.token,
    expected: localHost,
  });
  t.after(() => socket.close());
  const approve = (requestId: string) =>
    socket.request('approveFolder', { host: localHost, requestId, path: folder }).then(
      (value) => ({ value }),
      (error: ApplicationError) => ({ code: error.code }),
    );
  // A refusal applied nothing, so the same request runs again once it can succeed.
  const before = f.dispatched.length;
  assert.deepEqual(await approve('refused'), { code: 'InvalidInput' });
  await mkdir(folder);
  assert.deepEqual(await approve('refused'), { value: { requestId: 'refused', path: folder } });
  assert.deepEqual(f.dispatched.slice(before), ['approveFolder', 'approveFolder']);
  // A failure after the daemon applied the request answers its repeat without running it.
  f.afterDispatch = async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'Lost after applying.' });
  };
  assert.deepEqual(await approve('applied'), { code: 'Unavailable' });
  f.afterDispatch = undefined;
  assert.deepEqual(await approve('applied'), { code: 'Unavailable' });
  assert.deepEqual(f.dispatched.slice(before), ['approveFolder', 'approveFolder', 'approveFolder']);
  // So is any code that is not a refusal, such as a partial write.
  f.afterDispatch = async () => {
    throw new ApplicationError({ code: 'Persistence', message: 'Partly written.' });
  };
  assert.deepEqual(await approve('partial'), { code: 'Persistence' });
  f.afterDispatch = undefined;
  assert.deepEqual(await approve('partial'), { code: 'Persistence' });
  assert.equal(f.dispatched.length - before, 4);
});

test('daemon refusals reach the client with fixed public messages, never host text', async (t) => {
  const f = await setupLocal(t);
  const owner = f.owner('document-reasons');
  const refusesWith = async (promise: Promise<unknown>, reason: keyof typeof daemonErrorReasons) =>
    assert.rejects(promise, (error: ApplicationError) => {
      assert.deepEqual({ code: error.code, message: error.message }, daemonErrorReasons[reason]);
      return true;
    });
  await refusesWith(
    owner.command('startProviderLogin', { providerId: 'claude-code' }),
    'claude-code-sign-in',
  );
  await refusesWith(
    owner.command('logoutProvider', { providerId: 'claude-code' }),
    'claude-code-sign-in',
  );
  await refusesWith(
    owner.command('startProviderLogin', { providerId: 'not-installed' }),
    'unknown-provider',
  );
  await refusesWith(
    owner.command('cancelProviderLogin', { flowId: 'no-flow' }),
    'sign-in-inactive',
  );
  const started = await owner.command('startProviderLogin', { providerId: 'anthropic' });
  const prompt = (
    await untilState(
      () => owner.command('getProviders', {}),
      (state) => !!state.flow?.prompt,
    )
  ).flow!.prompt!;
  const flowId = started.flow!.id;
  await refusesWith(
    owner.command('answerProviderPrompt', { flowId, promptId: 'old-prompt', answer: 'key' }),
    'prompt-obsolete',
  );
  await refusesWith(
    owner.command('answerProviderPrompt', { flowId, promptId: prompt.id, answer: '  ' }),
    'invalid-answer',
  );
  await refusesWith(owner.command('openProviderUrl', { flowId }), 'no-sign-in-url');
  await f.host(f.providers.releaseOwner('document-reasons'));
  await refusesWith(owner.command('getProviders', {}), 'owner-released');
  await refusesWith(
    f.host(
      f.folders.approveFolder({ host: localHost, requestId: 'gone', path: join(f.dir, 'gone') }),
    ),
    'folder-missing',
  );
  await refusesWith(
    f.host(f.folders.checkChatFolder({ host: localHost, path: f.dir })),
    'not-chat-folder',
  );
  await refusesWith(
    f.host(f.folders.checkApprovedFolder({ host: localHost, path: f.dir })),
    'folder-not-approved',
  );
  // A refusal without a reason gets the client's own generic text, not chat wording.
  await assert.rejects(
    f.host(
      f.folders.markFolderAsProject({
        requestId: 'mark',
        target: { ...localSession, conversationId: 'missing-chat' },
      }),
    ),
    (error: ApplicationError) => {
      assert(!error.message.startsWith('Chat '), error.message);
      return true;
    },
  );
});

test('a client refuses a chat host that does not advertise local mode, and its local-mode features', async (t) => {
  const f = await setup(t);
  // A local-mode chat host that serves no daemon operations advertises only chat-v0.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-only-'))),
    runtime = ManagedRuntime.make(
      LocalPiRuntimeLive({
        ...localSession,
        databasePath: join(dir, 'chat.sqlite'),
        models: createModels(),
      }),
    ),
    scope = Effect.runSync(Scope.make());
  t.after(async () => {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const client = makeChatClient(runtime),
    calls: string[] = [];
  const counted: ChatClient = {
    ...client,
    command: (operation, input, options) => {
      calls.push(operation);
      return client.command(operation, input, options);
    },
  };
  const server = await runtime.runPromise(
    serveChat({ host: localHost, token: f.token, port: 0 }, counted).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  const endpoint: VerifiedChatEndpoint = {
    origin: server.origin,
    token: f.token,
    expected: localHost,
    connectionId: 'local-only',
    health: { ...localHost, protocol: 2, version: '0.1.0', capabilities: ['chat-v0'] },
  };
  const unadvertised = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteChatLive,
      RemoteLocalHostLive,
      RemoteProviderSetupLive({ host: localHost, sameMachine: false, openUrl: async () => {} }),
    ).pipe(
      Layer.provide(
        Layer.succeed(ConnectionService, {
          getConnection: () => Effect.die('unused'),
          connect: () => Effect.die('unused'),
          disconnect: () => Effect.die('unused'),
          watch: () => Stream.empty,
          endpoint: () => Effect.sync(() => structuredClone(endpoint)),
        }),
      ),
    ),
  );
  t.after(() => unadvertised.dispose());
  const remote = makeChatClient(unadvertised);
  await assert.rejects(remote.command('getChatHost', { host: localHost }), {
    code: 'Incompatible',
  });
  const folders = await unadvertised.runPromise(LocalHostService);
  await assert.rejects(unadvertised.runPromise(folders.getActiveWork({ host: localHost })), {
    code: 'Incompatible',
  });
  await assert.rejects(
    unadvertised.runPromise(
      folders.approveFolder({ host: localHost, requestId: 'approve', path: tmpdir() }),
    ),
    { code: 'Incompatible' },
  );
  await assert.rejects(
    makeProviderSetupClient(unadvertised, 'document').command('getProviders', {}),
    { code: 'Incompatible' },
  );
  await assert.rejects(
    remote.command('createChat', {
      session: localSession,
      requestId: 'with-settings',
      title: 'Local settings',
      settings: { model: { provider: 'faux', modelId: 'faux' } },
    }),
    { code: 'Incompatible' },
  );
  // Only the host read reached it.
  assert.deepEqual(
    calls.filter((operation) => operation !== 'getChatHost'),
    [],
  );
});
