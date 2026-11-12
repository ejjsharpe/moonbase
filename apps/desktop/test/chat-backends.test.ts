import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createChatBackends } from '../src/main/chat-backends.ts';

type Dependencies = Parameters<typeof createChatBackends>[0];
type Backend = NonNullable<Dependencies['localResult']['backend']>;
/** Makes real folders under a new resolved temporary directory, returning that directory. */
async function makeFolders(...names: string[]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-backends-')));
  for (const name of names) await mkdir(join(base, name), { recursive: true });
  return base;
}
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
    installationId: 'installation',
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
      localResult: {
        backend: null,
        error: new ApplicationError({ code: 'Unavailable', message: 'No local chat' }),
      },
      acquireLocal: () => new Promise(() => {}),
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

test('a new worktree starts only from a folder local chat may use, asks the daemon for it, and repeats only an unknown one', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const base = await makeFolders('editor');
  const editor = join(base, 'editor');
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const requests: { requestId: string; root: string; branch: string }[] = [],
    adopted: string[] = [];
  let failure: ApplicationError | undefined;
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
          return failure
            ? Effect.fail(failure)
            : Effect.succeed(
                checkout(`${input.root}-worktrees/${input.branch.replaceAll('/', '-')}`),
              );
        },
      },
    },
  );
  const make = () =>
    createChatBackends({
      runtime,
      installationId: 'installation',
      localResult: { backend, error: null },
      acquireLocal: async () => ({ backend, error: null }),
      emit: () => {},
      pickFolder: async () => null,
      isEditorFolder: (path) => path === editor,
      adoptCheckout: (target) => adopted.push(target.root),
    });
  const owner = make();
  try {
    await assert.rejects(owner.createWorktree('/elsewhere', 'chat/a'), { code: 'Unauthorized' });
    assert.equal(requests.length, 0);
    assert.equal(await owner.createWorktree('/repo', 'chat/a'), '/repo-worktrees/chat-a');
    assert.equal(requests[0].root, '/repo');
    // The daemon's worktree is offered to the editor, and an editor project needs no daemon grant.
    assert.deepEqual(adopted, ['/repo-worktrees/chat-a']);
    assert.equal(await owner.createWorktree(editor, 'b'), `${editor}-worktrees/b`);
    // A worktree whose outcome is unknown is asked for again under its request; a refusal is not.
    failure = new ApplicationError({ code: 'Uncertain', message: 'Reply lost.' });
    await assert.rejects(owner.createWorktree('/repo', 'late'), { code: 'Uncertain' });
    await assert.rejects(owner.createWorktree('/repo', 'late'), { code: 'Uncertain' });
    failure = new ApplicationError({ code: 'Conflict', message: 'Taken.' });
    await assert.rejects(owner.createWorktree('/repo', 'late'), { code: 'Conflict' });
    await assert.rejects(owner.createWorktree('/repo', 'late'), { code: 'Conflict' });
    const late = requests.filter((request) => request.branch === 'late').map((r) => r.requestId);
    assert.equal(late[0], late[1]);
    assert.equal(late[1], late[2]);
    assert.notEqual(late[2], late[3]);
    // Replacing the document while a creation runs cancels it; its worktree is not offered.
    failure = undefined;
    adopted.length = 0;
    let finish!: () => void;
    backend.workspace.createChatWorktree = ((input: { root: string; branch: string }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ).pipe(Effect.as(checkout(`${input.root}-worktrees/${input.branch}`)))) as never;
    const pending = owner.createWorktree('/repo', 'slow');
    await new Promise((resolve) => setImmediate(resolve));
    await owner.releaseDocument();
    finish?.();
    await assert.rejects(pending, { code: 'Cancelled' });
    assert.deepEqual(adopted, []);
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
test('turning a chat into a project is one daemon operation, and its checkout is offered to the editor', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const requests: { installationId: string; target: { conversationId: string } }[] = [],
    adopted: string[] = [];
  let refusal: ApplicationError | undefined;
  const backend = makeBackend(
    session,
    {},
    {
      workspace: {
        turnChatIntoProject: (input: {
          installationId: string;
          target: { conversationId: string };
        }) => {
          requests.push(input);
          return refusal ? Effect.fail(refusal) : Effect.succeed(checkout('/profile/chats/own'));
        },
      },
    },
  );
  const owner = createChatBackends({
    runtime,
    installationId: 'installation',
    localResult: { backend, error: null },
    acquireLocal: async () => ({ backend, error: null }),
    emit: () => {},
    pickFolder: async () => null,
    adoptCheckout: (target) => adopted.push(target.root),
  });
  try {
    refusal = new ApplicationError({ code: 'Unauthorized', message: 'Not a chat folder.' });
    await assert.rejects(owner.turnIntoProject('planted'), { code: 'Unauthorized' });
    assert.deepEqual(adopted, []);
    refusal = undefined;
    assert.equal(await owner.turnIntoProject('own'), '/profile/chats/own');
    assert.deepEqual(adopted, ['/profile/chats/own']);
    assert.deepEqual(
      requests.map(({ installationId, target }) => [installationId, target.conversationId]),
      [
        ['installation', 'planted'],
        ['installation', 'own'],
      ],
    );
  } finally {
    await owner.releaseDocument();
    await runtime.dispose();
  }
});

test('a remote daemon host offers its approved roots for folders, its own provider setup, and no local folder actions', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const context = { host: { hostId: 'remote-host', storeId: 'store' }, actorId: 'actor' };
  const listed: unknown[] = [],
    released: string[] = [],
    providerCalls: [string, string][] = [];
  const backends = createChatBackends({
    runtime,
    installationId: 'installation',
    localResult: {
      backend: null,
      error: new ApplicationError({ code: 'Unavailable', message: 'No local chat' }),
    },
    acquireLocal: () => new Promise(() => {}),
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
