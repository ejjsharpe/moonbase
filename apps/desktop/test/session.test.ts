import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Layer, ManagedRuntime } from 'effect';
import { createMoonbaseApplication } from '@moonbase/application';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';
const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
import {
  ApplicationError,
  emptyRecovery,
  type EditorClient,
  type CheckoutTarget,
  type WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import { EditorSession } from '../src/session.ts';
import { bridgeClient, errorDTO, failure, type Reply } from '../src/wire.ts';
const target: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/approved',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
function fixture() {
  let dispatches = 0,
    stops = 0,
    signal: AbortSignal | undefined;
  const events: WorkspaceEvent[] = [];
  const client: EditorClient = {
    command: async (name, _input, options) => {
      dispatches++;
      signal = options?.signal;
      if (name === 'openCheckout') return target as never;
      if (name === 'listWorktrees')
        return {
          worktrees: [
            { root: '/approved', branch: 'main', main: true, locked: false, prunable: false },
            {
              root: '/approved-topic',
              branch: 'topic',
              main: false,
              locked: false,
              prunable: false,
            },
          ],
        } as never;
      if (name === 'loadRecovery')
        return {
          revision: 0,
          state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
          operations: [],
          errors: [],
        } as never;
      if (name === 'readFile')
        return (await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(
              new ApplicationError({
                code: 'Cancelled',
                message: 'cancelled',
                target: { checkout: target, path: 'a.ts' },
              }),
            ),
          ),
        )) as never;
      return undefined as never;
    },
    watch(_input, receive) {
      receive({ checkout: target, paths: [] });
      return async () => {
        stops++;
      };
    },
  };
  const session = new EditorSession(
    runtime,
    client,
    {
      chooseCheckout: async () => '/approved',
      imports: async () => ['opaque'],
      release: async () => {},
    },
    (_id, event) => {
      if (event.ok) events.push(event.value);
    },
  );
  const call = (operation: string, input: unknown, id: string = crypto.randomUUID()) =>
    session.call('command', { operation, input }, id);
  return {
    session,
    call,
    events,
    get dispatches() {
      return dispatches;
    },
    get stops() {
      return stops;
    },
    get signal() {
      return signal;
    },
  };
}
test('native approval, exact identity and caller validation reject before command dispatch', async () => {
  const f = fixture();
  for (const [name, input] of [
    ['openCheckout', { root: '/approved' }],
    ['toString', {}],
    ['readFile', { checkout: target, path: 'a.ts' }],
    ['loadRecovery', { clientId: 'foreign' }],
    ['loadRecovery', { clientId: 'desktop-primary', extra: true }],
  ] as const) {
    const result = await f.call(name, input);
    assert(!result.ok);
    assert.equal(f.dispatches, 0);
  }
  assert((await f.session.call('choose-checkout', null, 'native')).ok);
  assert((await f.call('openCheckout', { root: '/approved' })).ok);
  assert.equal(f.dispatches, 1);
  assert.equal(
    (await f.call('readFile', { checkout: { ...target, hostId: 'other' }, path: 'a.ts' })).ok,
    false,
  );
  assert.equal(
    (
      await f.call('persistRecovery', {
        clientId: 'desktop-primary',
        requestId: 'publish',
        expectedRevision: 0,
        state: { ...emptyRecovery('other'), checkouts: [target] },
      })
    ).ok,
    false,
  );
  assert.equal(f.dispatches, 1);
  await f.session.dispose();
});
test('listed worktrees of an approved checkout may open; renderer worktree locations may not', async () => {
  const f = fixture();
  assert((await f.session.call('choose-checkout', null, 'native')).ok);
  assert((await f.call('openCheckout', { root: '/approved' })).ok);
  assert.equal((await f.call('openCheckout', { root: '/approved-topic' })).ok, false);
  assert.equal(
    (await f.call('listWorktrees', { checkout: { ...target, checkoutId: 'unknown' } })).ok,
    false,
  );
  assert.equal(f.dispatches, 1);
  assert((await f.call('listWorktrees', { checkout: target })).ok);
  assert((await f.call('openCheckout', { root: '/approved-topic' })).ok);
  assert.equal((await f.call('openCheckout', { root: '/elsewhere' })).ok, false);
  const created = await f.call('createWorktree', {
    checkout: target,
    base: 'main',
    branch: 'feature',
    location: '/anywhere/feature',
  });
  assert(!created.ok);
  assert.equal(created.error.code, 'Unauthorized');
  assert.equal(f.dispatches, 3);
  await f.session.dispose();
});
test('a plain folder main trusts opens for the renderer, and Initialize Git replaces its approval', async () => {
  const folder: CheckoutTarget = {
    hostId: 'local',
    checkoutId: 'notes',
    projectId: 'notes',
    root: '/notes',
    vcs: 'none',
  };
  const initialized: CheckoutTarget = {
    ...folder,
    projectId: 'notes-repository',
    vcs: 'git',
    branch: 'main',
    worktree: 'main',
  };
  const dispatched: string[] = [];
  const client: EditorClient = {
    command: async (name) => {
      dispatched.push(name);
      if (name === 'openCheckout') return folder as never;
      if (name === 'initializeRepository') return initialized as never;
      return { paths: [] } as never;
    },
    watch: () => async () => {},
  };
  const session = new EditorSession(
    runtime,
    client,
    { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
    () => {},
  );
  const call = (operation: string, input: unknown) =>
    session.call('command', { operation, input }, crypto.randomUUID());
  const ignored = (checkout: unknown) =>
    call('getIgnoredPaths', { checkout, path: '', paths: ['a.txt'] });
  // The renderer cannot name the root, until main opens it as a project.
  assert.equal((await call('openCheckout', { root: folder.root })).ok, false);
  assert.deepEqual(await session.openFolderProject(folder.root), folder);
  assert((await call('openCheckout', { root: folder.root })).ok);
  assert((await ignored(folder)).ok);
  // A Git-shaped copy of the folder's target is not its approval.
  for (const shape of [
    { ...folder, branch: 'main', worktree: 'main' },
    { ...folder, vcs: 'git', branch: 'main', worktree: 'main' },
  ])
    assert.equal((await ignored(shape)).ok, false);
  const reply = await call('initializeRepository', { checkout: folder });
  assert(reply.ok);
  assert.deepEqual(reply.value, initialized);
  assert.equal((await ignored(folder)).ok, false);
  assert((await ignored(initialized)).ok);
  assert.equal((await call('initializeRepository', { checkout: folder })).ok, false);
  assert.deepEqual(dispatched, [
    'openCheckout',
    'openCheckout',
    'getIgnoredPaths',
    'initializeRepository',
    'getIgnoredPaths',
  ]);
  await session.dispose();
});
test('restored exact approvals, owned cancellation, failed-watch cleanup and disposal', async () => {
  const f = fixture();
  await f.call('loadRecovery', { clientId: 'desktop-primary' });
  const pending = f.call('readFile', { checkout: target, path: 'a.ts' }, 'owned');
  assert.equal((await f.call('readFile', { checkout: target, path: 'a.ts' }, 'owned')).ok, false);
  void f.session.cancel('other');
  assert.equal(f.signal?.aborted, false);
  void f.session.cancel('owned');
  assert.equal((await f.call('readFile', { checkout: target, path: 'a.ts' }, 'owned')).ok, false);
  const cancelled = await pending;
  assert(!cancelled.ok);
  assert.equal(cancelled.error.code, 'Cancelled');
  assert.deepEqual(cancelled.error.target, { checkout: target, path: 'a.ts' });
  assert.equal(
    (await f.session.call('watch', { checkout: target, paths: 'bad' }, 'watch')).ok,
    false,
  );
  assert((await f.session.call('watch', { checkout: target, paths: [] }, 'watch')).ok);
  assert.equal(f.events.length, 1);
  await f.session.dispose();
  assert.equal(f.stops, 1);
  assert.equal((await f.call('loadRecovery', { clientId: 'desktop-primary' })).ok, false);
});

test('ignore classification accepts a full folder listing only for an approved exact checkout', async () => {
  const f = fixture();
  try {
    await f.call('loadRecovery', { clientId: 'desktop-primary' });
    const before = f.dispatches;
    const input = { checkout: target, path: '', paths: Array(20000).fill('a.ts') };
    await f.call('getIgnoredPaths', input);
    assert.equal(f.dispatches, before + 1);
    assert.equal(
      (await f.call('getIgnoredPaths', { ...input, paths: Array(20001).fill('a.ts') })).ok,
      false,
    );
    assert.equal(
      (await f.call('getIgnoredPaths', { ...input, checkout: { ...target, hostId: 'foreign' } }))
        .ok,
      false,
    );
    assert.equal(f.dispatches, before + 1);
  } finally {
    await f.session.dispose();
  }
});

test('superseded classifications release desktop capacity for unrelated file commands', async () => {
  const memory = memoryWorkspace([
    { checkout: target, files: { 'a.ts': 'A', 'folder/nested.ts': 'nested' } },
  ]);
  const backend = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(backend),
    signals: AbortSignal[] = [];
  const session = new EditorSession(
    runtime,
    {
      ...raw,
      async command(name, input, options) {
        if (name === 'getIgnoredPaths' && (input as { path: string }).path === 'folder') {
          const signal = options?.signal;
          assert(signal);
          signals.push(signal);
          await new Promise<never>((_resolve, reject) => {
            const cancel = () =>
              reject(new ApplicationError({ code: 'Cancelled', message: 'Classifier cancelled' }));
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
          });
        }
        return raw.command(name, input, options);
      },
    },
    { chooseCheckout: async () => target.root, imports: async () => [], release: async () => {} },
    () => {},
  );
  const client = bridgeClient({
    call: session.call.bind(session),
    cancel: session.cancel.bind(session),
    events: () => () => {},
  } as never);
  const application = await createMoonbaseApplication({
    editors: [{ client, clientId: session.clientId }],
  });
  const editor = application.editors[0]!;
  try {
    assert((await session.call('choose-checkout', null, crypto.randomUUID())).ok);
    await editor.openCheckout(target.root);
    for (let index = 0; index < 160; index++) await editor.list(target, 'folder');
    assert.equal(signals.length, 160);
    assert(signals.slice(0, -1).every((signal) => signal.aborted));
    assert.equal(signals.at(-1)?.aborted, false);
    assert.equal(await editor.open({ checkout: target, path: 'a.ts' }), true);
    assert.deepEqual(editor.getSnapshot().errors, []);
  } finally {
    await application.dispose();
    await session.dispose();
    await backend.dispose();
  }
  assert(signals.every((signal) => signal.aborted));
});
test('error DTO reconstructs the application brand/code/target and rejects malformed DTOs', () => {
  for (const code of [
    'InvalidInput',
    'Conflict',
    'Persistence',
    'Uncertain',
    'Cancelled',
    'Unauthorized',
    'Unavailable',
    'Incompatible',
  ] as const) {
    const original = new ApplicationError({
      code,
      message: 'retained',
      target: { checkout: target, path: 'a.ts' },
    });
    const restored = failure(structuredClone(errorDTO(original)));
    assert(ApplicationError.is(restored));
    assert.equal(restored.code, code);
    assert.deepEqual(restored.target, original.target);
  }
  assert.equal(failure({ code: 'fake', message: 'x' }).code, 'Incompatible');
  assert.equal(
    failure({
      code: 'Uncertain',
      message: 'x',
      target: { checkout: { ...target, hostId: 42 }, path: 'a.ts' },
    }).code,
    'Incompatible',
  );
});
test('preaborted browser command sends nothing', async () => {
  let dispatched = 0;
  const signal = AbortSignal.abort();
  const client = bridgeClient({
    call: async () => {
      dispatched++;
      return { ok: true, value: null };
    },
  } as never);
  await assert.rejects(
    client.command('loadRecovery', { clientId: 'desktop-primary' }, { signal }),
    (e) => ApplicationError.is(e) && e.code === 'Cancelled',
  );
  assert.equal(dispatched, 0);
});
test('long-lived watches cannot consume command capacity or prevent disposal', async () => {
  const f = fixture();
  await f.call('loadRecovery', { clientId: 'desktop-primary' });
  for (let index = 0; index < 128; index++)
    assert((await f.session.call('watch', { checkout: target, paths: [] }, `watch-${index}`)).ok);
  assert.equal(
    (await f.session.call('watch', { checkout: target, paths: [] }, 'overflow')).ok,
    false,
  );
  assert((await f.call('loadRecovery', { clientId: 'desktop-primary' })).ok);
  await f.session.dispose();
  assert.equal(f.stops, 128);
});
test('document release retains approvals but cancels waits and isolates reused observer IDs', async () => {
  const receives: ((event: WorkspaceEvent) => void)[] = [];
  let stops = 0,
    sends = 0;
  const f = fixture();
  await f.call('loadRecovery', { clientId: 'desktop-primary' });
  const pending = f.call('readFile', { checkout: target, path: 'a.ts' }, 'wait');
  await f.session.releaseDocument();
  assert.equal(f.signal?.aborted, true);
  assert.equal((await pending).ok, false);
  assert((await f.call('loadRecovery', { clientId: 'desktop-primary' })).ok);
  await f.session.dispose();
  const client: EditorClient = {
    command: async () =>
      ({
        revision: 0,
        state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
        operations: [],
        errors: [],
      }) as never,
    watch: (_input, receive) => {
      receives.push(receive);
      return async () => {
        stops++;
      };
    },
  };
  const owner = new EditorSession(
    runtime,
    client,
    { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
    () => sends++,
  );
  await owner.call(
    'command',
    { operation: 'loadRecovery', input: { clientId: owner.clientId } },
    'load',
  );
  await owner.call('watch', { checkout: target, paths: [] }, 'reused');
  await owner.releaseDocument();
  assert.equal(stops, 1);
  await owner.call('watch', { checkout: target, paths: [] }, 'reused');
  receives[0]({ checkout: target, paths: ['old'] });
  assert.equal(sends, 0);
  receives[1]({ checkout: target, paths: ['new'] });
  assert.equal(sends, 1);
  await owner.dispose();
  assert.equal(stops, 2);
});

test('cancel joins the actual watch finalizer, fences delivery and retains its failure', async () => {
  const held = Promise.withResolvers<void>();
  let receive!: (event: WorkspaceEvent) => void,
    sends = 0,
    releases = 0;
  const client: EditorClient = {
    command: async () =>
      ({
        revision: 0,
        state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
        errors: [],
        operations: [],
      }) as never,
    watch: (_input, next) => {
      receive = next;
      return async () => {
        releases++;
        await held.promise;
      };
    },
  };
  const owner = new EditorSession(
    runtime,
    client,
    { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
    () => sends++,
  );
  await owner.call(
    'command',
    { operation: 'loadRecovery', input: { clientId: owner.clientId } },
    'load',
  );
  await owner.call('watch', { checkout: target, paths: [] }, 'watch');
  let done = false;
  const close = owner.cancel('watch');
  assert.equal(owner.cancel('watch'), close);
  void close.then(() => {
    done = true;
  });
  receive({ checkout: target, paths: ['late'] });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(sends, 0);
  assert(
    (
      await owner.call(
        'command',
        { operation: 'loadRecovery', input: { clientId: owner.clientId } },
        'other',
      )
    ).ok,
  );
  held.reject(new ApplicationError({ code: 'Persistence', message: 'watch release failed' }));
  const result = await close;
  assert(!result.ok);
  assert.equal(result.error.code, 'Persistence');
  assert.equal(releases, 1);
  assert.equal(await owner.cancel('watch'), result);
  await assert.rejects(owner.dispose(), { code: 'Persistence' });
});

test('document replacement joins late capture and releases it before completion without granting a new document', async () => {
  const capture = Promise.withResolvers<string[]>(),
    picker = Promise.withResolvers<string | null>();
  const released: string[][] = [];
  const client: EditorClient = {
    command: async () =>
      ({
        revision: 0,
        state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
        errors: [],
        operations: [],
      }) as never,
    watch: () => async () => {},
  };
  const owner = new EditorSession(
    runtime,
    client,
    {
      chooseCheckout: () => picker.promise,
      imports: () => capture.promise,
      release: async ({ references }) => {
        released.push(references);
      },
    },
    () => {},
  );
  await owner.call(
    'command',
    { operation: 'loadRecovery', input: { clientId: owner.clientId } },
    'load',
  );
  const native = owner.call('choose-imports', { checkout: target }, 'native');
  const choose = owner.call('choose-checkout', null, 'choose');
  let done = false;
  const cleanup = owner.releaseDocument();
  void cleanup.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  capture.resolve(['abandoned']);
  picker.resolve('/new-root');
  assert.equal((await native).ok, false);
  assert.equal((await choose).ok, false);
  await cleanup;
  assert.deepEqual(released, [['abandoned']]);
  const result = await owner.call(
    'command',
    { operation: 'openCheckout', input: { root: '/new-root' } },
    'foreign',
  );
  assert(!result.ok);
  assert.equal(result.error.code, 'Unauthorized');
  await owner.dispose();
});

test('browser watch close fences immediately and keeps completion handling until cancellation acknowledgment', async () => {
  const held = Promise.withResolvers<Reply<null>>();
  let receive!: (id: string, result: Reply) => void,
    id = '',
    removed = 0,
    delivered = 0;
  const client = bridgeClient({
    call: async (_method: string, _input: unknown, request: string) => {
      id = request;
      return { ok: true, value: null };
    },
    cancel: () => held.promise,
    events: (next: typeof receive) => {
      receive = next;
      return () => {
        removed++;
      };
    },
  } as never);
  const close = client.watch(
    { checkout: target, paths: [] },
    () => delivered++,
    () => {},
  );
  const pending = close();
  assert.equal(close(), pending);
  receive(id, { ok: true, value: { checkout: target, paths: [] } });
  await Promise.resolve();
  assert.equal(removed, 0);
  assert.equal(delivered, 0);
  held.resolve({ ok: false, error: { code: 'Persistence', message: 'cleanup failed' } });
  await assert.rejects(pending, { code: 'Persistence' });
  assert.equal(removed, 1);
});

test('desktop errors redact unknown private diagnostics and reply envelopes remain strict', async () => {
  const secret = 'private-token-and-path-must-not-escape';
  const result = errorDTO(new Error(secret));
  assert(!result.message.includes(secret));
  const client = bridgeClient({
    call: async () => ({ ok: 'forged', value: { revision: 0 } }),
  } as never);
  await assert.rejects(client.command('loadRecovery', { clientId: 'desktop-primary' }), {
    code: 'Incompatible',
  });
});

test('late native capture release failure remains in document and session cleanup after the old reply is lost', async () => {
  const captured = Promise.withResolvers<string[]>();
  const client: EditorClient = {
    command: async () =>
      ({
        revision: 0,
        state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
        operations: [],
        errors: [],
      }) as never,
    watch: () => async () => {},
  };
  const owner = new EditorSession(
    runtime,
    client,
    {
      chooseCheckout: async () => null,
      imports: () => captured.promise,
      release: async () => {
        throw new ApplicationError({ code: 'Persistence', message: 'Late capture release failed' });
      },
    },
    () => {},
  );
  await owner.call(
    'command',
    { operation: 'loadRecovery', input: { clientId: owner.clientId } },
    'load',
  );
  const oldReply = owner.call('choose-imports', { checkout: target }, 'capture');
  const documentCleanup = owner.releaseDocument();
  const documentOutcome = documentCleanup.then(
    () => undefined,
    (error: unknown) => error,
  );
  captured.resolve(['abandoned-token']);
  const reply = await oldReply;
  assert(!reply.ok);
  assert.equal(reply.error.code, 'Persistence');
  const error = await documentOutcome;
  assert(ApplicationError.is(error));
  assert.equal(error.code, 'Persistence');
  await assert.rejects(owner.dispose(), { code: 'Persistence' });
});

test('cancelling native capture in a live document releases unpublished references before acknowledgment', async () => {
  const captured = Promise.withResolvers<string[]>(),
    releasing = Promise.withResolvers<void>(),
    releaseGate = Promise.withResolvers<void>();
  let attempts = 0;
  const client: EditorClient = {
    command: async () =>
      ({
        revision: 0,
        state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
        operations: [],
        errors: [],
      }) as never,
    watch: () => async () => {},
  };
  const owner = new EditorSession(
    runtime,
    client,
    {
      chooseCheckout: async () => null,
      imports: () => captured.promise,
      release: async () => {
        attempts++;
        releasing.resolve();
        await releaseGate.promise;
      },
    },
    () => {},
  );
  await owner.call(
    'command',
    { operation: 'loadRecovery', input: { clientId: owner.clientId } },
    'load',
  );
  const oldReply = owner.call('choose-imports', { checkout: target }, 'capture');
  let done = false;
  const acknowledgment = owner.cancel('capture');
  void acknowledgment.then(() => {
    done = true;
  });
  captured.resolve(['unpublished-token']);
  await releasing.promise;
  assert.equal(attempts, 1);
  assert.equal(done, false);
  releaseGate.resolve();
  assert.equal((await oldReply).ok, false);
  assert((await acknowledgment).ok);
  await owner.dispose();
});

for (const failure of ['none', 'release', 'acquisition'] as const) {
  test(`reentrant editor watch cancellation joins the acquired close (${failure})`, async () => {
    const releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let acknowledgment: ReturnType<EditorSession['cancel']> | undefined,
      releases = 0,
      delivered = 0;
    const expected = new ApplicationError({
      code: 'Persistence',
      message: 'Owned reentrant editor watch failure',
    });
    const client: EditorClient = {
      command: async () =>
        ({
          revision: 0,
          state: { ...emptyRecovery('desktop-primary'), checkouts: [target] },
          operations: [],
          errors: [],
        }) as never,
      watch: (_input, receive) => {
        receive({ checkout: target, paths: [] });
        if (failure === 'acquisition') throw expected;
        receive({ checkout: target, paths: ['late'] });
        return async () => {
          releases++;
          releasing.resolve();
          await gate.promise;
        };
      },
    };
    const owner = new EditorSession(
      runtime,
      client,
      { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
      () => {
        delivered++;
        acknowledgment = owner.cancel('watch');
      },
    );
    await owner.call(
      'command',
      { operation: 'loadRecovery', input: { clientId: owner.clientId } },
      'load',
    );
    const watching = owner.call('watch', { checkout: target, paths: [] }, 'watch');
    assert(acknowledgment);
    let settled = false;
    void acknowledgment.then(() => {
      settled = true;
    });
    if (failure !== 'acquisition') {
      await releasing.promise;
      assert.equal(settled, false);
      assert.equal(releases, 1);
      if (failure === 'release') gate.reject(expected);
      else gate.resolve();
    }
    const reply = await acknowledgment;
    const watchReply = await watching;
    assert.equal(reply.ok, failure === 'none');
    assert.equal(watchReply.ok, failure === 'none');
    assert.equal(delivered, 1);
    if (failure === 'none') await owner.dispose();
    else {
      assert(!reply.ok);
      assert.equal(reply.error.code, 'Persistence');
      await assert.rejects(owner.dispose(), { code: 'Persistence' });
    }
  });
}
test('a chat worktree is made beside the main worktree, never where a renderer says', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-worktree-')));
  try {
    const repository = join(directory, 'repo'),
      linked = join(directory, 'repo-worktrees', 'topic');
    const checkout = { ...target, root: linked, worktree: 'linked' as const };
    const created: unknown[] = [];
    const client: EditorClient = {
      command: async (name, input) => {
        if (name === 'openCheckout') return checkout as never;
        if (name === 'listWorktrees')
          return {
            worktrees: [
              { root: repository, branch: 'main', main: true, locked: false, prunable: false },
              { root: linked, branch: 'topic', main: false, locked: false, prunable: false },
            ],
          } as never;
        if (name === 'createWorktree') {
          created.push(input);
          // The first name is taken, as when a chat with the same opening already has one.
          if (created.length === 1)
            throw new ApplicationError({ code: 'Conflict', message: 'Branch exists.' });
          const location = (input as { location: string }).location;
          return { ...target, checkoutId: 'new', root: location, worktree: 'linked' } as never;
        }
        throw Error(`Unexpected ${name}`);
      },
      watch: () => async () => {},
    };
    const session = new EditorSession(
      runtime,
      client,
      { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
      () => {},
    );
    assert.equal(session.hasFolder(linked), false);
    for (const branch of ['../escape', '-flag', 'a..b', 'chat/', 'with space'])
      await assert.rejects(session.createChatWorktree(linked, branch), {
        code: 'InvalidInput',
      });
    const root = await session.createChatWorktree(linked, 'chat/tidy-the-composer');
    const parent = join(directory, 'repo-worktrees');
    assert.equal(root, join(parent, 'chat-tidy-the-composer-2'));
    assert.deepEqual(created, [
      {
        checkout,
        base: 'HEAD',
        branch: 'chat/tidy-the-composer',
        location: join(parent, 'chat-tidy-the-composer'),
      },
      {
        checkout,
        base: 'HEAD',
        branch: 'chat/tidy-the-composer-2',
        location: join(parent, 'chat-tidy-the-composer-2'),
      },
    ]);
    assert(session.hasFolder(root));
    assert((await stat(parent)).isDirectory());
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('chat worktrees are made one at a time, fall back from a blocked prefix and leave no empty folder', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-worktree-')));
  try {
    const repository = join(directory, 'repo');
    const checkout = { ...target, root: repository };
    const branches = new Set(['chat']);
    let failNext = false;
    const client: EditorClient = {
      command: async (name, input, options) => {
        if (name === 'openCheckout') return checkout as never;
        if (name === 'listWorktrees')
          return {
            worktrees: [
              { root: repository, branch: 'main', main: true, locked: false, prunable: false },
            ],
          } as never;
        if (name === 'createWorktree') {
          const { branch, location } = input as { branch: string; location: string };
          await new Promise((resolve) => setTimeout(resolve, 5));
          options?.signal?.throwIfAborted();
          if (failNext) {
            failNext = false;
            throw new ApplicationError({ code: 'Unavailable', message: 'HEAD is unborn.' });
          }
          if (branches.has(branch))
            throw new ApplicationError({ code: 'Conflict', message: 'Branch exists.' });
          // Git refuses `chat/…` while a branch named `chat` exists.
          if (branches.has(branch.split('/')[0]!) && branch.includes('/'))
            throw new ApplicationError({ code: 'Unavailable', message: 'Cannot lock ref.' });
          branches.add(branch);
          return { ...target, checkoutId: location, root: location, worktree: 'linked' } as never;
        }
        throw Error(`Unexpected ${name}`);
      },
      watch: () => async () => {},
    };
    const session = new EditorSession(
      runtime,
      client,
      { chooseCheckout: async () => null, imports: async () => [], release: async () => {} },
      () => {},
    );
    const parent = join(directory, 'repo-worktrees');
    // An unborn HEAD fails without the prefix fallback hiding it, and removes the folder it made.
    failNext = true;
    await assert.rejects(session.createChatWorktree(repository, 'task'), { code: 'Unavailable' });
    await assert.rejects(stat(parent), { code: 'ENOENT' });
    // Two at once with the same name each get their own worktree.
    const [first, second] = await Promise.all([
      session.createChatWorktree(repository, 'chat/fix'),
      session.createChatWorktree(repository, 'chat/fix'),
    ]);
    assert.equal(first, join(parent, 'chat-fix'));
    assert.equal(second, join(parent, 'chat-fix-2'));
    assert(branches.has('chat-fix') && branches.has('chat-fix-2'));
    // A released document's creation grants nothing.
    const released = new AbortController();
    const late = session.createChatWorktree(repository, 'late', released.signal);
    released.abort();
    await assert.rejects(late);
    assert.equal(session.hasFolder(join(parent, 'late')), false);
    assert(session.hasFolder(first));
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
