import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createChatBackends } from '../src/main/chat-backends.ts';

test('chat backends join explicit local retry and revoke pending folder selection on document replacement', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const approved: string[] = [],
    released: string[] = [];
  let attempts = 0;
  type Dependencies = Parameters<typeof createChatBackends>[0];
  type Backend = NonNullable<Dependencies['localResult']['backend']>;
  // Only folder approval and owner release are exercised; no chat/provider command is dispatched.
  const backend = {
    session,
    chat: {},
    approveFolder: async (path: string) => {
      approved.push(path);
      return path;
    },
    providers: {
      releaseOwner: (owner: string) =>
        Effect.sync(() => {
          released.push(owner);
        }),
    },
    control: { setAdmissionsOpen() {}, hasActiveWork: () => Effect.succeed(false) },
  } as unknown as Backend;
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
    assert.equal(owner.hasLocalChat(), false);
    assert.equal(owner.getSessions().length, 0);
    const first = owner.getContext('local'),
      second = owner.getContext('local');
    assert.equal(attempts, 1);
    completeRetry({ backend, error: null });
    assert.deepEqual(await first, session);
    assert.deepEqual(await second, session);
    assert.equal(owner.hasLocalChat(), true);
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
    type Dependencies = Parameters<typeof createChatBackends>[0];
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
  type Backend = NonNullable<Parameters<typeof createChatBackends>[0]['localResult']['backend']>;
  const backend = {
    session,
    chat: {},
    approveFolder: async (path: string) => {
      approved.push(path);
      return path;
    },
    requireApprovedFolder: async (path: string) => {
      if (path !== '/repo')
        throw new ApplicationError({ code: 'Unauthorized', message: 'Choose this folder.' });
    },
    providers: { releaseOwner: () => Effect.void },
    control: { setAdmissionsOpen() {}, hasActiveWork: () => Effect.succeed(false) },
  } as unknown as Backend;
  const owner = createChatBackends({
    runtime,
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {},
    pickFolder: async () => null,
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
    assert.deepEqual(approved, ['/repo-worktrees/chat-a']);
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});
