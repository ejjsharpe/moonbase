import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Clock, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { makeChatBackends, type ChatBackendsOptions } from '../src/main/chat/chat-backends.ts';
import { makeChatDocument } from '../src/main/chat/chat-document.ts';
import { makeLocalDaemonClient, type DaemonChat } from '../src/main/daemon/local-daemon-client.ts';
import { createFileRequestIds } from '../src/main/request-ids.ts';

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
const reached = (backend: Backend | null): ChatBackendsOptions['local'] =>
  backend
    ? { get: Effect.succeed(backend), peek: Effect.succeed(backend) }
    : { get: Effect.never, peek: Effect.succeed(undefined) };
/** A daemon backend whose folder operations are the given handlers; others are never called. */
function makeBackend(
  session: Backend['session'],
  folders: Partial<Record<keyof Backend['folders'], (input: never) => unknown>>,
  rest: Partial<Record<'chat' | 'providers' | 'workspace', unknown>> = {},
) {
  const effect = (run: (input: never) => unknown) => (input: never) =>
    Effect.try({ try: () => run(input), catch: (error) => error as ApplicationError });
  return {
    session,
    chat: {},
    providers: { releaseOwner: () => Effect.void },
    ...rest,
    folders: Object.fromEntries(Object.entries(folders).map(([name, run]) => [name, effect(run!)])),
  } as unknown as Backend;
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect)) as Promise<E>;

test('local chat shares one attempt to reach the daemon, answers a failed one for a moment, and a cancelled folder choice approves nothing', async (t) => {
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const approved: string[] = [];
  let attempts = 0,
    now = 0;
  const backend = makeBackend(session, {
    approveFolder: ({ path }: { path: string }) => {
      approved.push(path);
      return { requestId: 'r', path };
    },
  });
  let acquiring = Effect.runSync(Deferred.make<Backend, ApplicationError>());
  const scope = Scope.makeUnsafe();
  t.after(() => run(Scope.close(scope, Exit.void)));
  // A clock whose time the test moves; it sleeps as the real one does.
  const clock: Clock.Clock = Object.create(Clock.Clock.defaultValue(), {
    currentTimeMillisUnsafe: { value: () => now },
    currentTimeMillis: { value: Effect.sync(() => now) },
  });
  const local = await run(
    Scope.provide(
      makeLocalDaemonClient(
        Effect.suspend(() => {
          attempts++;
          acquiring = Effect.runSync(Deferred.make<Backend, ApplicationError>());
          return Deferred.await(acquiring);
        }),
      ),
      scope,
    ),
  );
  let picked = Effect.runSync(Deferred.make<string | null>());
  const owner = makeChatBackends({
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local: {
      get: local.get.pipe(Effect.provideService(Clock.Clock, clock)),
      peek: local.peek,
    },
    pickFolder: Effect.suspend(() => Deferred.await(picked)),
  });
  assert.equal(attempts, 0);
  // A failed attempt is every caller's answer for a moment, then tried anew.
  const failing = run(Effect.flip(owner.getContext('local')));
  await new Promise((resolve) => setImmediate(resolve));
  await run(
    Deferred.fail(
      acquiring,
      new ApplicationError({ code: 'Unavailable', message: 'spawn failed' }),
    ),
  );
  assert.equal((await failing).code, 'Unavailable');
  assert.equal((await fail(owner.getContext('local'))).code, 'Unavailable');
  assert.equal(attempts, 1);
  now += 2000;
  const first = run(owner.getContext('local')),
    second = run(owner.getContext('local'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  await run(Deferred.succeed(acquiring, backend));
  assert.deepEqual(await first, session);
  assert.deepEqual(await second, session);
  // A choice whose request is cancelled while the picker is open approves nothing.
  const picking = Effect.runFork(owner.chooseFolder);
  await new Promise((resolve) => setImmediate(resolve));
  await run(Fiber.interrupt(picking));
  await run(Deferred.succeed(picked, '/obsolete'));
  assert.deepEqual(approved, []);
  picked = Effect.runSync(Deferred.make<string | null>());
  const current = run(owner.chooseFolder);
  await run(Deferred.succeed(picked, '/current'));
  assert.equal(await current, '/current');
  assert.deepEqual(approved, ['/current']);
  await run(owner.getContext('local'));
  assert.equal(attempts, 2);
});

test('a document releases its provider sign-ins as it goes, on the remote host too, but not on Quit', async () => {
  const released: string[] = [];
  let closing = false;
  const releaseOwner =
    (name: string, failing = false) =>
    (owner: string) =>
      Effect.suspend(() => {
        released.push(`${name}:${owner}`);
        return failing
          ? Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Gone.' }))
          : Effect.void;
      });
  const backend = makeBackend(
    { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' },
    {},
    { providers: { releaseOwner: releaseOwner('local') } },
  );
  const backends = makeChatBackends({
    installationId: 'installation',
    requestIds: createFileRequestIds('/nonexistent/never-written.json'),
    local: reached(backend),
    // A remote host that can't be reached is released on a best effort.
    remote: {
      configuration: { context: {}, ssh: { profile: { label: 'Host' } } },
      providers: { releaseOwner: releaseOwner('remote', true) },
    } as unknown as ChatBackendsOptions['remote'],
    pickFolder: Effect.succeed(null),
  });
  const open = async () => {
    const scope = Scope.makeUnsafe();
    const document = await run(
      Scope.provide(makeChatDocument(backends, { isClosing: Effect.sync(() => closing) }), scope),
    );
    return { document, close: () => run(Scope.close(scope, Exit.void)) };
  };
  const first = await open();
  await first.close();
  assert.deepEqual(released.sort(), [`local:${first.document.id}`, `remote:${first.document.id}`]);
  const second = await open();
  assert.notEqual(second.document.id, first.document.id);
  // Quit closes the daemon connections, which releases every owner.
  closing = true;
  await second.close();
  assert.equal(released.length, 2);
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

test('a new worktree starts only from a folder the daemon approves, under the renderer’s request, and a cancelled one is not offered', async (t) => {
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
  const owner = makeChatBackends({
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local: reached(backend),
    pickFolder: Effect.succeed(null),
    adoptCheckout: (target) => adopted.push(target.root),
  });
  // Even a worktree Git lists for an approved checkout is the daemon's to approve.
  assert.equal(
    (await fail(owner.createWorktree('/repo-worktrees/listed', 'chat/a', 'first'))).code,
    'Unauthorized',
  );
  assert.equal(requests.length, 0);
  assert.equal(
    await run(owner.createWorktree('/repo', 'chat/a', 'second')),
    '/repo-worktrees/chat-a',
  );
  assert.deepEqual(
    requests.map(({ requestId, root }) => [requestId, root]),
    [['second', '/repo']],
  );
  // The daemon's worktree is offered to the editor.
  assert.deepEqual(adopted, ['/repo-worktrees/chat-a']);
  // A creation whose document goes is interrupted; its worktree is not offered.
  adopted.length = 0;
  const finish = Effect.runSync(Deferred.make<void>());
  backend.workspace.createChatWorktree = ((input: { root: string; branch: string }) =>
    Deferred.await(finish).pipe(
      Effect.as(checkout(`${input.root}-worktrees/${input.branch}`)),
    )) as never;
  const pending = Effect.runFork(owner.createWorktree('/repo', 'slow', 'third'));
  await new Promise((resolve) => setImmediate(resolve));
  await run(Fiber.interrupt(pending));
  await run(Deferred.succeed(finish, undefined));
  assert.deepEqual(adopted, []);
});
test('turning a chat into a project is one daemon operation, asked again only while its outcome is unknown, and its checkout is offered to the editor', async (t) => {
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
    makeChatBackends({
      installationId: 'installation',
      requestIds,
      local: reached(backend),
      pickFolder: Effect.succeed(null),
      adoptCheckout: (target) => adopted.push(target.root),
    });
  const owner = make();
  refusal = new ApplicationError({ code: 'Unauthorized', message: 'Not a chat folder.' });
  assert.equal((await fail(owner.turnIntoProject('planted'))).code, 'Unauthorized');
  assert.deepEqual(adopted, []);
  // An unknown outcome is asked for again under its request, after a restart too; an answer,
  // a refusal included, is final.
  refusal = new ApplicationError({ code: 'Uncertain', message: 'Reply lost.' });
  assert.equal((await fail(owner.turnIntoProject('own'))).code, 'Uncertain');
  assert.equal((await fail(make().turnIntoProject('own'))).code, 'Uncertain');
  refusal = undefined;
  assert.equal(await run(owner.turnIntoProject('own')), '/profile/chats/own');
  assert.deepEqual(adopted, ['/profile/chats/own']);
  await run(owner.turnIntoProject('own'));
  await run(owner.turnIntoProject('planted'));
  const ids = (conversationId: string) =>
    requests.filter((r) => r.target.conversationId === conversationId).map((r) => r.requestId);
  const own = ids('own'),
    planted = ids('planted');
  assert.deepEqual(new Set(own.slice(0, 3)).size, 1);
  assert.notEqual(own[2], own[3]);
  assert.notEqual(planted[0], planted[1]);
  assert(requests.every((request) => request.installationId === 'installation'));
});

test('a remote daemon host offers its approved roots for folders, and local chat nothing until reached', async (t) => {
  const context = { host: { hostId: 'remote-host', storeId: 'store' }, actorId: 'actor' };
  const listed: unknown[] = [];
  const backends = makeChatBackends({
    installationId: 'installation',
    requestIds: await makeRequestIds(t),
    local: reached(null),
    remote: {
      configuration: { context, ssh: { profile: { label: 'Mac mini' } } },
      folders: {
        listHostFolders: (input: unknown) =>
          Effect.sync(() => {
            listed.push(input);
            return { folders: ['/Users/host/projects', '/Users/host/projects/site'] };
          }),
      },
    } as unknown as ChatBackendsOptions['remote'],
    pickFolder: Effect.sync(() => assert.fail('A remote host has no native picker')),
  });
  assert.deepEqual(
    backends.targets.map(({ id, label, mode }) => ({ id, label, mode })),
    [
      { id: 'local', label: 'Local', mode: 'local' },
      { id: 'remote', label: 'Mac mini', mode: 'remote' },
    ],
  );
  assert.deepEqual(await run(backends.recentFolders('remote')), [
    '/Users/host/projects',
    '/Users/host/projects/site',
  ]);
  assert.deepEqual(listed, [{ host: context.host }]);
  // Local chat is not available, so its recent folders are empty and it has no clients yet.
  assert.deepEqual(await run(backends.recentFolders('local')), []);
  assert.equal(await run(backends.findTarget('local')), undefined);
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
