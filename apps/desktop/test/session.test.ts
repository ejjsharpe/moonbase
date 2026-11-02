import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Layer, ManagedRuntime } from 'effect';
const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
import {
  ApplicationError,
  emptyRecovery,
  type EditorClient,
  type CheckoutTarget,
  type WorkspaceEvent,
} from '@moonbase/application/client';
import { EditorSession } from '../src/session.ts';
import { bridgeClient, errorDTO, failure, type Reply } from '../src/wire.ts';
const target: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/approved',
  branch: 'main',
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
