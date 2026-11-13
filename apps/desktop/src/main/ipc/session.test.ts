import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
import { EditorSession } from './session.ts';
import { bridgeClient, errorDTO, failure, type Reply } from '../../shared/ipc/wire.ts';
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
            {
              root: '/approved',
              branch: 'main',
              main: true,
              locked: false,
              prunable: false,
            },
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
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => '/approved',
      imports: async () => ['opaque'],
      release: async () => {},
    },
    (_id, event) => {
      if (event.ok) events.push(event.value);
    },
    async () => 'local',
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
    (
      await f.call('readFile', {
        checkout: { ...target, hostId: 'other' },
        path: 'a.ts',
      })
    ).ok,
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
    (
      await f.call('listWorktrees', {
        checkout: { ...target, checkoutId: 'unknown' },
      })
    ).ok,
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
    {
      chooseCheckout: async () => null,
      imports: async () => [],
      copyText: async () => {},
      reveal: async () => {},
      release: async () => {},
    },
    () => {},
    async () => 'local',
  );
  const call = (operation: string, input: unknown) =>
    session.call('command', { operation, input }, crypto.randomUUID());
  const ignored = (checkout: unknown) =>
    call('getIgnoredPaths', { checkout, path: '', paths: ['a.txt'] });
  // The renderer cannot name the root, until main opens it as a project.
  assert.equal((await call('openCheckout', { root: folder.root })).ok, false);
  // A checkout the daemon made for a chat is approved by main, which may then open it.
  session.adoptCheckout(folder);
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
    const input = {
      checkout: target,
      path: '',
      paths: Array(20000).fill('a.ts'),
    };
    await f.call('getIgnoredPaths', input);
    assert.equal(f.dispatches, before + 1);
    assert.equal(
      (
        await f.call('getIgnoredPaths', {
          ...input,
          paths: Array(20001).fill('a.ts'),
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await f.call('getIgnoredPaths', {
          ...input,
          checkout: { ...target, hostId: 'foreign' },
        })
      ).ok,
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
              reject(
                new ApplicationError({
                  code: 'Cancelled',
                  message: 'Classifier cancelled',
                }),
              );
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
          });
        }
        return raw.command(name, input, options);
      },
    },
    {
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => target.root,
      imports: async () => [],
      release: async () => {},
    },
    () => {},
    async () => 'local',
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
    // A folder keeps one superseded classification running so refreshes cannot starve Git: the
    // first here, which never answers. Every later superseded one is cancelled.
    assert.equal(signals[0].aborted, false, 'The kept classification stays live');
    assert(signals.slice(1, -1).every((signal) => signal.aborted));
    assert.equal(signals.at(-1)?.aborted, false);
    assert.equal(signals.filter((signal) => !signal.aborted).length, 2);
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
    {
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => null,
      imports: async () => [],
      release: async () => {},
    },
    () => sends++,
    async () => 'local',
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
    {
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => null,
      imports: async () => [],
      release: async () => {},
    },
    () => sends++,
    async () => 'local',
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
  held.reject(
    new ApplicationError({
      code: 'Persistence',
      message: 'watch release failed',
    }),
  );
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
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: () => picker.promise,
      imports: () => capture.promise,
      release: async ({ references }) => {
        released.push(references);
      },
    },
    () => {},
    async () => 'local',
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
  held.resolve({
    ok: false,
    error: { code: 'Persistence', message: 'cleanup failed' },
  });
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
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => null,
      imports: () => captured.promise,
      release: async () => {
        throw new ApplicationError({
          code: 'Persistence',
          message: 'Late capture release failed',
        });
      },
    },
    () => {},
    async () => 'local',
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
      copyText: async () => {},
      reveal: async () => {},
      chooseCheckout: async () => null,
      imports: () => captured.promise,
      release: async () => {
        attempts++;
        releasing.resolve();
        await releaseGate.promise;
      },
    },
    () => {},
    async () => 'local',
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
      {
        copyText: async () => {},
        reveal: async () => {},
        chooseCheckout: async () => null,
        imports: async () => [],
        release: async () => {},
      },
      () => {
        delivered++;
        acknowledgment = owner.cancel('watch');
      },
      async () => 'local',
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
test('copy-paths and reveal reach native actions only for approved checkouts and paths inside them', async () => {
  // A real folder, so reveal can follow links: `out` points outside the checkout.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-reveal-')));
  const root = join(base, 'checkout');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'A');
  await writeFile(join(base, 'secret'), 'S');
  await symlink(base, join(root, 'out'));
  const checkout = { ...target, root };
  const memory = memoryWorkspace([{ checkout, files: { 'src/a.ts': 'A' } }]);
  const backend = ManagedRuntime.make(memory.layer);
  const copied: string[] = [],
    revealed: string[] = [];
  let localHost: string | undefined = 'local';
  const session = new EditorSession(
    runtime,
    makeEditorClient(backend),
    {
      copyText: async (text) => {
        copied.push(text);
      },
      reveal: async (path) => {
        revealed.push(path);
      },
      chooseCheckout: async () => root,
      imports: async () => [],
      release: async () => {},
    },
    () => {},
    async () => localHost,
  );
  const call = (method: string, input: unknown) => session.call(method, input, crypto.randomUUID());
  const copy = (paths: unknown, relative: unknown = false) =>
    call('copy-paths', { checkout, paths, relative });
  try {
    // Not yet approved: the renderer naming a checkout grants nothing.
    assert.equal((await copy(['src/a.ts'])).ok, false);
    assert.equal((await call('reveal', { checkout, path: 'src/a.ts' })).ok, false);
    assert((await call('choose-checkout', null)).ok);
    assert((await call('command', { operation: 'openCheckout', input: { root } })).ok);
    assert((await copy(['src/a.ts', ''])).ok);
    assert((await copy(['src/a.ts', 'src'], true)).ok);
    assert.deepEqual(copied, [`${join(root, 'src/a.ts')}\n${root}`, 'src/a.ts\nsrc']);
    for (const paths of [[], 'src/a.ts', [7], Array.from({ length: 20001 }, () => 'a')])
      assert.equal((await copy(paths)).ok, false, JSON.stringify(paths).slice(0, 40));
    assert.equal((await copy(['src/a.ts'], 'yes')).ok, false);
    assert((await call('reveal', { checkout, path: 'src/a.ts' })).ok);
    assert((await call('reveal', { checkout, path: '' })).ok);
    for (const path of [
      '../outside',
      'src/../../outside',
      '/etc/hosts',
      './src',
      'src//a.ts',
      'src\\a.ts',
      'src/\0',
      'a'.repeat(4097),
      // Inside by name, outside once the link is followed.
      'out/secret',
      // Gone since the menu opened.
      'src/missing.ts',
    ]) {
      assert.equal((await call('reveal', { checkout, path })).ok, false, path.slice(0, 40));
      assert.equal((await copy([path])).ok, path === 'out/secret' || path === 'src/missing.ts');
    }
    assert.equal(
      (
        await call('reveal', {
          checkout: { ...checkout, root: base },
          path: 'secret',
        })
      ).ok,
      false,
    );
    assert.deepEqual(revealed, [join(root, 'src/a.ts'), root]);
    // Files of a host that is not this Mac's daemon can be copied by path but not shown in Finder.
    localHost = 'another-host';
    assert.equal((await call('reveal', { checkout, path: 'src/a.ts' })).ok, false);
    assert((await copy(['src/a.ts'])).ok);
    localHost = undefined;
    assert.equal((await call('reveal', { checkout, path: 'src/a.ts' })).ok, false);
    assert.equal(revealed.length, 2);
  } finally {
    await session.dispose();
    await backend.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
