import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createChatBackends } from '../src/main/chat-backends.ts';

type Dependencies = Parameters<typeof createChatBackends>[0];
type Backend = NonNullable<Dependencies['localResult']['backend']>;
/** A daemon backend whose folder operations are the given handlers; others are never called. */
function makeBackend(
  session: Backend['session'],
  folders: Partial<Record<keyof Backend['folders'], (input: never) => unknown>>,
  rest: Partial<Record<'chat' | 'providers', unknown>> = {},
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

test('chat backends join explicit local retry and revoke pending folder selection on document replacement', async () => {
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
  let completeRetry!: (result: Dependencies['localResult']) => void;
  let completePicker!: (path: string | null) => void;
  const owner = createChatBackends({
    runtime,
    localResult: {
      backend: null,
      error: new ApplicationError({ code: 'Unavailable', message: 'Not ready' }),
    },
    acquireLocal: () => {
      attempts++;
      return new Promise((resolve) => {
        completeRetry = resolve;
      });
    },
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
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
    const first = owner.getContext('local'),
      second = owner.getContext('local');
    assert.equal(attempts, 1);
    completeRetry({ backend, error: null });
    assert.deepEqual(await first, session);
    assert.deepEqual(await second, session);
    assert.deepEqual(owner.getTargets()[0].context, session);
    assert.equal(owner.getSessions().length, 1);
    const previous = owner.getSession('local');
    const picking = owner.chooseFolder();
    await owner.releaseDocument();
    completePicker('/obsolete');
    assert.equal(await picking, null);
    assert.deepEqual(approved, []);
    assert.notEqual(owner.getSession('local'), previous);
    assert.equal(released.length, 1);
    const current = owner.chooseFolder();
    completePicker('/current');
    assert.equal(await current, '/current');
    assert.deepEqual(approved, ['/current']);
    await owner.getContext('local');
    assert.equal(attempts, 1);
    await owner.releaseDocument();
    assert.equal(released.length, 2);
    assert.notEqual(released[0], released[1]);
  } finally {
    for (const session of owner.getSessions()) await session.dispose();
    await runtime.dispose();
  }
});

for (const failure of [false, true])
  test(`document replacement routes a reused ID to the new session and joins ${failure ? 'failing' : 'held'} old release`, async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
    const target = { ...context, conversationId: 'chat' };
    const releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const receives: ((snapshot: never) => void)[] = [],
      releases = [0, 0],
      emitted: [string, string][] = [];
    const remoteChat: Dependencies['remoteChat'] = {
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
      localResult: {
        backend: null,
        error: new ApplicationError({ code: 'Unavailable', message: 'No local chat' }),
      },
      acquireLocal: () => new Promise(() => {}),
      // Only the remote context and label are read when installing the session.
      chatConfiguration: {
        context,
        ssh: { profile: { label: 'Remote' } },
      } as unknown as Dependencies['chatConfiguration'],
      remoteChat,
      connection: { command: async () => ({}) as never, watch: () => async () => {} },
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

test('a new worktree starts only from a folder local chat may use, and is approved for it', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const approved: string[] = [],
    created: string[] = [];
  const grants: string[] = [];
  const backend = makeBackend(session, {
    approveFolder: ({ path, recent }: { path: string; recent?: boolean }) => {
      (path.includes('-worktrees/') ? approved : grants).push(
        `${path}${recent === false ? '' : ' recent'}`,
      );
      return { requestId: 'r', path };
    },
    checkApprovedFolder: ({ path }: { path: string }) => {
      if (path !== '/repo')
        throw new ApplicationError({ code: 'Unauthorized', message: 'Choose this folder.' });
    },
  });
  const owner = createChatBackends({
    runtime,
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {},
    pickFolder: async () => null,
    isEditorFolder: (path) => path === '/editor',
    createWorktree: async (root, branch) => {
      created.push(`${root} ${branch}`);
      return `${root}-worktrees/${branch.replaceAll('/', '-')}`;
    },
  });
  try {
    await assert.rejects(owner.createWorktree('/elsewhere', 'chat/a'), { code: 'Unauthorized' });
    assert.deepEqual(created, []);
    assert.equal(await owner.createWorktree('/repo', 'chat/a'), '/repo-worktrees/chat-a');
    assert.deepEqual(created, ['/repo chat/a']);
    assert.deepEqual(approved, ['/repo-worktrees/chat-a']);
    // An editor checkout is granted to the daemon before a worktree starts from it.
    assert.equal(await owner.createWorktree('/editor', 'b'), '/editor-worktrees/b');
    assert.deepEqual(grants, ['/editor']);
    assert.deepEqual(approved, ['/repo-worktrees/chat-a', '/editor-worktrees/b']);
    // Replacing the document cancels a creation in flight; its worktree is not approved.
    let finish!: () => void;
    let signal!: AbortSignal;
    const slow = createChatBackends({
      runtime,
      localResult: { backend, error: null },
      acquireLocal: async () => ({ backend, error: null }),
      chatConfiguration: null,
      remoteChat: null,
      connection: null,
      emit: () => {},
      pickFolder: async () => null,
      createWorktree: (root, branch, creation) => {
        signal = creation;
        return new Promise((resolve) => {
          finish = () => resolve(`${root}-worktrees/${branch}`);
        });
      },
    });
    const pending = slow.createWorktree('/repo', 'late');
    await new Promise((resolve) => setImmediate(resolve));
    await slow.releaseDocument();
    assert(signal.aborted);
    finish();
    await assert.rejects(pending, { code: 'Cancelled' });
    assert.deepEqual(approved, ['/repo-worktrees/chat-a', '/editor-worktrees/b']);
    assert.deepEqual(grants, ['/editor']);
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});
test('turning a chat into a project opens only its own folder, then lists it under that project', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const chats: Record<string, { cwd: string; ownFolder?: true }> = {
    own: { cwd: '/profile/chats/2026-11-08-notes-a1b2c3d4', ownFolder: true },
    project: { cwd: '/repo' },
    planted: { cwd: '/elsewhere', ownFolder: true },
  };
  const opened: string[] = [],
    marked: string[] = [];
  let failOpen = false;
  const backend = makeBackend(
    session,
    {
      checkChatFolder: ({ path }: { path: string }) => {
        if (!path.startsWith('/profile/chats/'))
          throw new ApplicationError({ code: 'Unauthorized', message: 'Not a chat folder.' });
      },
      markFolderAsProject: ({
        requestId,
        target,
      }: {
        requestId: string;
        target: { conversationId: string };
      }) => {
        marked.push(target.conversationId);
        delete chats[target.conversationId].ownFolder;
        return { requestId };
      },
    },
    {
      chat: {
        getChat: ({ target }: { target: { conversationId: string } }) =>
          Effect.succeed({ conversation: chats[target.conversationId] }),
      },
    },
  );
  const owner = createChatBackends({
    runtime,
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {},
    pickFolder: async () => null,
    openFolderProject: async (root) => {
      if (failOpen) throw new ApplicationError({ code: 'Unavailable', message: 'Busy.' });
      opened.push(root);
      return root;
    },
  });
  try {
    await assert.rejects(owner.turnIntoProject('project'), { code: 'InvalidInput' });
    await assert.rejects(owner.turnIntoProject('planted'), { code: 'Unauthorized' });
    // A failed open leaves the chat without a project, ready to try again.
    failOpen = true;
    await assert.rejects(owner.turnIntoProject('own'), { code: 'Unavailable' });
    assert.deepEqual(marked, []);
    failOpen = false;
    assert.equal(await owner.turnIntoProject('own'), chats.own.cwd);
    assert.deepEqual(opened, [chats.own.cwd]);
    assert.deepEqual(marked, ['own']);
    await assert.rejects(owner.turnIntoProject('own'), { code: 'InvalidInput' });
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});

test('an editor folder is granted to the daemon only when a chat first uses it, then once', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const grants: { path: string; recent?: boolean }[] = [],
    sent: unknown[] = [];
  let fail = true;
  const backend = makeBackend(
    session,
    {
      approveFolder: ({ path, recent }: { path: string; recent?: boolean }) => {
        grants.push({ path, recent });
        if (fail) throw new ApplicationError({ code: 'Unavailable', message: 'Daemon down.' });
        return { requestId: 'r', path };
      },
    },
    {
      chat: {
        createChat: (input: unknown) =>
          Effect.sync(() => {
            sent.push(input);
            return null;
          }),
        findChatFiles: (input: unknown) =>
          Effect.sync(() => {
            sent.push(input);
            return null;
          }),
      },
    },
  );
  // The editor approved a checkout and listed two of its worktrees; no chat has used any yet.
  const editorFolders = new Set(['/editor', '/editor-worktrees/a', '/editor-worktrees/unused']);
  const owner = createChatBackends({
    runtime,
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    isEditorFolder: (path) => editorFolders.has(path),
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {},
    pickFolder: async () => null,
  });
  const call = (operation: string, input: unknown) =>
    owner.getSession('local')!.call('chat', operation, input, crypto.randomUUID());
  const create = (cwd: string) =>
    call('createChat', {
      session,
      requestId: crypto.randomUUID(),
      title: 'Chat',
      settings: { cwd, model: { provider: 'faux', modelId: 'faux' } },
    });
  try {
    assert.equal('grantEditorFolder' in owner, false, 'nothing grants an editor folder eagerly');
    assert.equal(grants.length, 0);
    // A failed grant fails the chat's request and is tried again on the folder's next use.
    const failed = await create('/editor');
    assert(!failed.ok && failed.error.code === 'Unavailable');
    assert.deepEqual(grants, [{ path: '/editor', recent: false }]);
    assert.equal(sent.length, 0);
    fail = false;
    assert((await create('/editor')).ok);
    assert.equal(grants.length, 2);
    assert((await call('findChatFiles', { session, cwd: '/editor', query: 'a' })).ok);
    assert((await create('/editor')).ok);
    assert.equal(grants.length, 2, 'a granted folder is not granted again');
    assert((await create('/editor-worktrees/a')).ok);
    assert.deepEqual(grants.slice(2), [{ path: '/editor-worktrees/a', recent: false }]);
    // A path the editor never approved is passed on as it is and gains nothing.
    assert((await create('/elsewhere')).ok);
    assert.equal(grants.length, 3);
    assert.equal(sent.length, 5);
    // The listed worktree no chat used was never granted.
    assert(!grants.some((grant) => grant.path === '/editor-worktrees/unused'));
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});

test('an editor folder the daemon no longer holds is granted again once, and the request retried once', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const grants: string[] = [],
    sent: { operation: string; requestId?: string }[] = [];
  // The daemon's grants: what it holds now, which a reset or a replaced folder empties.
  const held = new Set<string>();
  const refuse = (operation: string, input: { requestId?: string; cwd?: string }, cwd: string) =>
    Effect.suspend(() => {
      sent.push({ operation, requestId: input.requestId });
      return held.has(cwd)
        ? Effect.succeed(null)
        : Effect.fail(
            new ApplicationError({
              code: 'Unauthorized',
              message: 'Approve this working folder before creating or retrying a local chat.',
            }),
          );
    });
  const backend = makeBackend(
    session,
    {
      approveFolder: ({ path }: { path: string }) => {
        grants.push(path);
        held.add(path);
        return { requestId: 'r', path };
      },
    },
    {
      chat: {
        createChat: (input: { requestId: string; settings: { cwd: string } }) =>
          refuse('createChat', input, input.settings.cwd),
        findChatFiles: (input: { cwd: string }) => refuse('findChatFiles', input, input.cwd),
      },
    },
  );
  const owner = createChatBackends({
    runtime,
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    isEditorFolder: (path) => path === '/editor',
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {},
    pickFolder: async () => null,
  });
  const call = (operation: string, input: unknown) =>
    owner.getSession('local')!.call('chat', operation, input, crypto.randomUUID());
  const create = (cwd: string, requestId: string = crypto.randomUUID()) =>
    call('createChat', {
      session,
      requestId,
      title: 'Chat',
      settings: { cwd, model: { provider: 'faux', modelId: 'faux' } },
    });
  try {
    assert((await create('/editor')).ok);
    assert.deepEqual(grants, ['/editor']);
    // The daemon lost the grant; this process still remembers giving it.
    held.clear();
    sent.length = 0;
    assert((await create('/editor', 'same')).ok);
    assert.deepEqual(grants, ['/editor', '/editor'], 'granted again, uncached');
    assert.deepEqual(sent, [
      { operation: 'createChat', requestId: 'same' },
      { operation: 'createChat', requestId: 'same' },
    ]);
    held.clear();
    sent.length = 0;
    assert((await call('findChatFiles', { session, cwd: '/editor', query: 'a' })).ok);
    assert.equal(sent.length, 2);
    assert.equal(grants.length, 3);
    // A folder main may not grant is refused as it is, and not retried.
    sent.length = 0;
    const refused = await create('/elsewhere');
    assert(!refused.ok);
    assert.equal(refused.error.code, 'Unauthorized');
    assert.equal(sent.length, 1);
    // An editor folder refused again after its new grant is retried only once.
    const approveAgain = backend.folders.approveFolder;
    (backend.folders as { approveFolder: unknown }).approveFolder = (input: never) =>
      Effect.map(approveAgain(input), (value) => {
        held.clear();
        return value;
      });
    held.clear();
    sent.length = 0;
    assert(!(await create('/editor')).ok);
    assert.equal(sent.length, 2);
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});
