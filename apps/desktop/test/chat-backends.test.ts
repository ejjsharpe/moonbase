import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createChatBackends } from '../src/main/chat/chat-backends.ts';
import {
  createLocalDaemonClient,
  type DaemonChat,
} from '../src/main/daemon/local-daemon-client.ts';
import { createFileRequestIds } from '../src/main/request-ids.ts';

type Dependencies = Parameters<typeof createChatBackends>[0];
type Backend = DaemonChat;
/** A new resolved temporary directory, removed after the test. */
async function makeDirectory(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-backends-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
/** Request IDs in a temporary profile file, as main keeps them. */
const makeRequestIds = async (t: TestContext) =>
  createFileRequestIds(join(await makeDirectory(t), 'chat-requests.json'));
/** A local daemon client already holding `backend`, or one that is never reached. */
const reached = (backend: Backend | null) =>
  backend
    ? { get: async () => backend, peek: () => backend }
    : { get: () => new Promise<Backend>(() => {}), peek: () => null };
/** A daemon backend whose folder operations are the given handlers; others are never called. */
function makeBackend(
  session: Backend['session'],
  folders: Partial<Record<keyof Backend['folders'], (input: never) => unknown>>,
  rest: Partial<Record<'chat' | 'providers' | 'workspace', unknown>> = {},
) {
  const effect = (run: (input: never) => unknown) => (input: never) =>
    Effect.tryPromise({ try: async () => run(input), catch: (error) => error as ApplicationError });
  return {
    session,
    chat: {},
    providers: { releaseOwner: () => Effect.void },
    ...rest,
    folders: Object.fromEntries(Object.entries(folders).map(([name, run]) => [name, effect(run!)])),
  } as unknown as Backend;
}

test('local chat shares one attempt to reach the daemon, answers a failed one for a moment, and revokes pending folder selection on document replacement', async (t) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const approved: string[] = [],
    released: string[] = [];
  let attempts = 0;
  // Only folder approval and owner release are exercised; no chat/provider command is dispatched.
  const backend = makeBackend(
    session,
    {
      approveFolder: ({ path }: { path: string }) => {
        approved.push(path);
        return { requestId: 'r', path };
      },
    },
    {
      providers: {
        releaseOwner: (owner: string) =>
          Effect.sync(() => {
            released.push(owner);
          }),
      },
    },
  );
  let acquiring!: PromiseWithResolvers<Backend>;
  let completePicker!: (path: string | null) => void;
  // The picker opens once the daemon is reached.
  const pickerOpened = () => new Promise((resolve) => setImmediate(resolve));
  let clock = 0;
  const local = createLocalDaemonClient(
    () => {
      attempts++;
      acquiring = Promise.withResolvers<Backend>();
      return acquiring.promise;
    },
    () => clock,
  );
  const owner = createChatBackends({
    runtime,
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local,
    emit: () => {
      assert.fail('No observation should be started');
    },
    pickFolder: () =>
      new Promise((resolve) => {
        completePicker = resolve;
      }),
  });
  try {
    assert.equal(attempts, 0);
    assert.equal(owner.getSessions().length, 0);
    // A failed attempt is every caller's answer for a moment, then tried anew.
    const failing = owner.getContext('local');
    acquiring.reject(Error('spawn failed'));
    await assert.rejects(failing, { code: 'Unavailable' });
    await assert.rejects(owner.getContext('local'), { code: 'Unavailable' });
    assert.equal(attempts, 1);
    clock += 2000;
    const first = owner.getContext('local'),
      second = owner.getContext('local');
    assert.equal(attempts, 2);
    acquiring.resolve(backend);
    assert.deepEqual(await first, session);
    assert.deepEqual(await second, session);
    assert.equal(owner.getSessions().length, 1);
    const previous = owner.getSession('local');
    const picking = owner.chooseFolder();
    await pickerOpened();
    await owner.releaseDocument();
    completePicker('/obsolete');
    assert.equal(await picking, null);
    assert.deepEqual(approved, []);
    assert.notEqual(owner.getSession('local'), previous);
    assert.equal(released.length, 1);
    const current = owner.chooseFolder();
    await pickerOpened();
    completePicker('/current');
    assert.equal(await current, '/current');
    assert.deepEqual(approved, ['/current']);
    await owner.getContext('local');
    assert.equal(attempts, 2);
    await owner.releaseDocument();
    assert.equal(released.length, 2);
    assert.notEqual(released[0], released[1]);
  } finally {
    for (const session of owner.getSessions()) await session.dispose();
    await runtime.dispose();
  }
});

for (const failure of [false, true])
  test(`document replacement routes a reused ID to the new session and joins ${failure ? 'failing' : 'held'} old release`, async (t) => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
    const target = { ...context, conversationId: 'chat' };
    const releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const receives: ((snapshot: never) => void)[] = [],
      releases = [0, 0],
      emitted: [string, string][] = [];
    const remoteChat: NonNullable<Dependencies['remote']>['chat'] = {
      watchChatList: () => async () => {},
      command: async () => null as never,
      watch: (_input, receive) => {
        const index = receives.length;
        receives.push(receive as (snapshot: never) => void);
        return async () => {
          releases[index]++;
          if (index === 0) {
            releasing.resolve();
            await gate.promise;
          }
        };
      },
    };
    const backends = createChatBackends({
      runtime,
      installationId: 'installation',
      requestIds: await makeRequestIds(t),
      local: reached(null),
      // Only the remote context and label, the chat and owner release are used here.
      remote: {
        configuration: { context, ssh: { profile: { label: 'Remote' } } },
        chat: remoteChat,
        connection: { command: async () => ({}) as never, watch: () => async () => {} },
        providers: { releaseOwner: () => Effect.void },
        folders: {},
      } as unknown as Dependencies['remote'],
      emit: (backendId, id) => emitted.push([backendId, id]),
      pickFolder: async () => null,
    });
    try {
      const old = backends.getSession('remote')!;
      assert((await old.call('watch-chat', '', { target }, 'reused')).ok);
      const replacement = backends.releaseDocument().then(
        () => undefined,
        (error: unknown) => error,
      );
      let settled = false;
      void replacement.then(() => {
        settled = true;
      });
      await releasing.promise;
      const current = backends.getSession('remote')!;
      assert.notEqual(current, old);
      assert((await current.call('watch-chat', '', { target }, 'reused')).ok);
      receives[0]!({} as never);
      receives[1]!({} as never);
      assert.deepEqual(emitted, [['remote', 'reused']], 'the old watch is fenced');
      assert((await current.call('connection', 'getConnection', {}, 'unrelated')).ok);
      assert.equal(settled, false, 'replacement joins the held old release');
      if (failure)
        gate.reject(new ApplicationError({ code: 'Persistence', message: 'Old release failed' }));
      else gate.resolve();
      const error = await replacement;
      if (failure) {
        assert(ApplicationError.is(error));
        assert.equal(error.code, 'Persistence');
      } else assert.equal(error, undefined);
      assert((await current.cancel('reused')).ok);
      assert.deepEqual(releases, [1, 1]);
    } finally {
      gate.resolve();
      for (const session of backends.getSessions()) await session.dispose().catch(() => {});
      await runtime.dispose();
    }
  });

const checkout = (root: string) => ({
  hostId: 'local',
  checkoutId: `checkout-${root}`,
  projectId: 'project',
  root,
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'linked' as const,
});

test('a new worktree starts only from a folder the daemon approves, under the renderer’s request, and a replaced document’s is not offered', async (t) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const requests: { requestId: string; root: string; branch: string }[] = [],
    adopted: string[] = [];
  const backend = makeBackend(
    session,
    {
      checkApprovedFolder: ({ path }: { path: string }) => {
        if (path !== '/repo')
          throw new ApplicationError({ code: 'Unauthorized', message: 'Choose this folder.' });
      },
    },
    {
      workspace: {
        createChatWorktree: (input: { requestId: string; root: string; branch: string }) => {
          requests.push(input);
          return Effect.succeed(
            checkout(`${input.root}-worktrees/${input.branch.replaceAll('/', '-')}`),
          );
        },
      },
    },
  );
  const owner = createChatBackends({
    runtime,
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local: reached(backend),
    emit: () => {},
    pickFolder: async () => null,
    adoptCheckout: (target) => adopted.push(target.root),
  });
  try {
    // Even a worktree Git lists for an approved checkout is the daemon's to approve.
    await assert.rejects(owner.createWorktree('/repo-worktrees/listed', 'chat/a', 'first'), {
      code: 'Unauthorized',
    });
    assert.equal(requests.length, 0);
    assert.equal(await owner.createWorktree('/repo', 'chat/a', 'second'), '/repo-worktrees/chat-a');
    assert.deepEqual(
      requests.map(({ requestId, root }) => [requestId, root]),
      [['second', '/repo']],
    );
    // The daemon's worktree is offered to the editor.
    assert.deepEqual(adopted, ['/repo-worktrees/chat-a']);
    // Replacing the document while a creation runs cancels it; its worktree is not offered.
    adopted.length = 0;
    let finish!: () => void;
    backend.workspace.createChatWorktree = ((input: { root: string; branch: string }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ).pipe(Effect.as(checkout(`${input.root}-worktrees/${input.branch}`)))) as never;
    const pending = owner.createWorktree('/repo', 'slow', 'third');
    await new Promise((resolve) => setImmediate(resolve));
    await owner.releaseDocument();
    finish?.();
    await assert.rejects(pending, { code: 'Cancelled' });
    assert.deepEqual(adopted, []);
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});
test('turning a chat into a project is one daemon operation, asked again only while its outcome is unknown, and its checkout is offered to the editor', async (t) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const requests: {
      installationId: string;
      requestId: string;
      target: { conversationId: string };
    }[] = [],
    adopted: string[] = [];
  let refusal: ApplicationError | undefined;
  const backend = makeBackend(
    session,
    {},
    {
      workspace: {
        turnChatIntoProject: (input: (typeof requests)[number]) => {
          requests.push(input);
          return refusal ? Effect.fail(refusal) : Effect.succeed(checkout('/profile/chats/own'));
        },
      },
    },
  );
  // The request IDs outlive a backend, as they do across a reload or restart.
  const requestIds = await makeRequestIds(t);
  const make = () =>
    createChatBackends({
      runtime,
      installationId: 'installation',
      requestIds,
      local: reached(backend),
      emit: () => {},
      pickFolder: async () => null,
      adoptCheckout: (target) => adopted.push(target.root),
    });
  const owner = make();
  try {
    refusal = new ApplicationError({ code: 'Unauthorized', message: 'Not a chat folder.' });
    await assert.rejects(owner.turnIntoProject('planted'), { code: 'Unauthorized' });
    assert.deepEqual(adopted, []);
    // An unknown outcome is asked for again under its request, after a restart too; an answer,
    // a refusal included, is final.
    refusal = new ApplicationError({ code: 'Uncertain', message: 'Reply lost.' });
    await assert.rejects(owner.turnIntoProject('own'), { code: 'Uncertain' });
    await assert.rejects(make().turnIntoProject('own'), { code: 'Uncertain' });
    refusal = undefined;
    assert.equal(await owner.turnIntoProject('own'), '/profile/chats/own');
    assert.deepEqual(adopted, ['/profile/chats/own']);
    await owner.turnIntoProject('own');
    await owner.turnIntoProject('planted');
    const ids = (conversationId: string) =>
      requests.filter((r) => r.target.conversationId === conversationId).map((r) => r.requestId);
    const own = ids('own'),
      planted = ids('planted');
    assert.deepEqual(new Set(own.slice(0, 3)).size, 1);
    assert.notEqual(own[2], own[3]);
    assert.notEqual(planted[0], planted[1]);
    assert(requests.every((request) => request.installationId === 'installation'));
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});

test('a remote daemon host offers its approved roots for folders, its own provider setup, and no local folder actions', async (t) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const context = { host: { hostId: 'remote-host', storeId: 'store' }, actorId: 'actor' };
  const listed: unknown[] = [],
    released: string[] = [],
    providerCalls: [string, string][] = [];
  const backends = createChatBackends({
    runtime,
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local: reached(null),
    remote: {
      configuration: { context, ssh: { profile: { label: 'Mac mini' } } },
      chat: { command: async () => null as never, watch: () => async () => {} },
      connection: { command: async () => ({}) as never, watch: () => async () => {} },
      providers: {
        forOwner: (owner: string) => ({
          getProviders: () =>
            Effect.sync(() => {
              providerCalls.push([owner, 'getProviders']);
              return { providers: [], flow: null };
            }),
        }),
        releaseOwner: (owner: string) =>
          Effect.sync(() => {
            released.push(owner);
          }),
      },
      folders: {
        listHostFolders: (input: unknown) =>
          Effect.sync(() => {
            listed.push(input);
            return { folders: ['/Users/host/projects', '/Users/host/projects/site'] };
          }),
      },
    } as unknown as Dependencies['remote'],
    emit: () => {},
    pickFolder: async () => assert.fail('A remote host has no native picker'),
  });
  try {
    assert.deepEqual(
      backends.getTargets().map(({ id, label, mode }) => ({ id, label, mode })),
      [
        { id: 'local', label: 'Local', mode: 'local' },
        { id: 'remote', label: 'Mac mini', mode: 'remote' },
      ],
    );
    assert.deepEqual(await backends.recentFolders('remote'), [
      '/Users/host/projects',
      '/Users/host/projects/site',
    ]);
    assert.deepEqual(listed, [{ host: context.host }]);
    // Local chat is not available, so its recent folders are empty and nothing reaches the host.
    assert.deepEqual(await backends.recentFolders('local'), []);
    const session = backends.getSession('remote')!;
    assert((await session.call('providers', 'getProviders', {}, 'providers')).ok);
    assert.equal(providerCalls.length, 1);
    // A chat on the host names its settings; one without them is refused before it is sent.
    await assert.rejects(
      session.call(
        'chat',
        'createChat',
        { session: context, requestId: 'missing', title: 'Missing settings' },
        'missing',
      ),
      { code: 'InvalidInput' },
    );
    await backends.releaseDocument();
    assert.deepEqual(released, [providerCalls[0]![0]]);
  } finally {
    for (const session of backends.getSessions()) await session.dispose();
    await runtime.dispose();
  }
});

test('request ids last until deleted, across a new handle, and tolerate a corrupt file', async (t) => {
  const file = join(await makeDirectory(t), 'request-ids.json');
  const ids = createFileRequestIds(file);
  ids.put('k', 'a');
  ids.put('other', 'b');
  assert.equal(createFileRequestIds(file).get('k'), 'a');
  ids.delete('k');
  assert.equal(createFileRequestIds(file).get('k'), undefined);
  assert.equal(createFileRequestIds(file).get('other'), 'b');
  await writeFile(file, '{not json');
  assert.equal(createFileRequestIds(file).get('other'), undefined);
});
