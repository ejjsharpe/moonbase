import { acquireEditor } from './editor-model-fixture.ts';
import * as controllerFixture from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
  type CommandInput,
} from '@moonbase/contracts/workspace';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'ready',
  projectId: 'project',
  root: '/memory/ready',
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const target = { checkout, path: 'a.ts' };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function fixture() {
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'disk' } }]),
    runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  let hold: ReturnType<typeof gate> | undefined,
    read: ReturnType<typeof gate> | undefined,
    entered = gate();
  const requests: CommandInput<'persistRecovery'>[] = [];
  const client: EditorClient = {
    ...raw,
    command(name, input, options) {
      if (name !== 'persistRecovery') {
        const wait = name === 'lookupFiles' ? read : undefined;
        read = undefined;
        if (wait) entered.release();
        return wait
          ? wait.promise.then(() => raw.command(name, input, options))
          : raw.command(name, input, options);
      }
      requests.push(structuredClone(input as CommandInput<'persistRecovery'>));
      const wait = hold;
      hold = undefined;
      entered.release();
      return wait
        ? wait.promise.then(() => raw.command(name, input, options))
        : raw.command(name, input, options);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'readiness' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.open(target);
  await editor.flush();
  return {
    runtime,
    memory,
    raw,
    editor,
    requests,
    hold() {
      entered = gate();
      hold = gate();
      return { entered: entered.promise, release: hold.release };
    },
    holdRead() {
      entered = gate();
      read = gate();
      return { entered: entered.promise, release: read.release };
    },
    async restart() {
      await editor.dispose();
      const next = await acquireEditor(runtime, { client: raw, clientId: editor.clientId });
      await next.load();
      return next;
    },
    async dispose() {
      await editor.dispose();
      await runtime.dispose();
    },
  };
}

test('queued resolution of publication A reconciles newer B only by its own retained identity', async () => {
  const f = await controllerFixture.fixture('publication-a-b', false);
  const entered = gate(),
    release = gate();
  const requests: CommandInput<'persistRecovery'>[] = [];
  const statuses: string[] = [];
  let loseReplies = false,
    holdStatus = false;
  const client: EditorClient = {
    ...f.client,
    watch: () => async () => {},
    async command(name, input, options) {
      if (loseReplies && name === 'persistRecovery') {
        requests.push(structuredClone(input as CommandInput<'persistRecovery'>));
        await f.client.command(name, input, options);
        throw new ApplicationError({ code: 'Uncertain', message: 'Publication reply lost' });
      }
      if (loseReplies && name === 'getRecoveryPublication') {
        statuses.push((input as CommandInput<'getRecoveryPublication'>).requestId);
        if (holdStatus) {
          holdStatus = false;
          entered.release();
          await release.promise;
          return f.client.command(name, input, options);
        }
        return null as never;
      }
      return f.client.command(name, input, options);
    },
  };
  await f.editor.dispose();
  const editor = await acquireEditor(f.runtime, { client, clientId: f.editor.clientId });
  try {
    await editor.load();
    await editor.openCheckout(controllerFixture.checkout.root);
    const file = controllerFixture.target('a.ts');
    await editor.open(file);
    await editor.flush();
    loseReplies = true;
    editor.edit(file, 'capture A');
    await assert.rejects(editor.flush());
    const a = editor.getSnapshot().publication!.requestId;
    holdStatus = true;
    const resolvingA = editor.resolveRecoveryPublication();
    await entered.promise;
    editor.edit(file, 'capture B');
    const publishingB = assert.rejects(editor.flush());
    const queuedResolution = editor.resolveRecoveryPublication();
    release.release();
    assert.equal(await resolvingA, true);
    await publishingB;
    assert.equal(await queuedResolution, false);
    const b = editor.getSnapshot().publication!.requestId;
    assert.notEqual(b, a);
    assert.deepEqual(statuses, [a, a, b, b]);
    assert.deepEqual(
      requests.map((request) => request.requestId),
      [a, b, b],
    );
    assert.deepEqual(requests[1], requests[2], 'only the original B payload may be retried');
    assert.equal(editor.buffer(file)!.text, 'capture B');
    assert.equal(editor.getSnapshot().recoveryReady, false);
    loseReplies = false;
    assert.equal(await editor.resolveRecoveryPublication(), true);
    assert.equal(editor.getSnapshot().publication, undefined);
    assert.equal(editor.getSnapshot().recoveryReady, true);
  } finally {
    release.release();
    await editor.dispose();
    await f.dispose();
  }
});

test('fresh capture invalidates exact recovery confirmation synchronously; confirmed dirty drafts allow unload', async () => {
  const f = await fixture();
  try {
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.edit(target, 'fresh visible tail');
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    assert.equal(f.editor.buffer(target)!.text, 'fresh visible tail');
    assert.equal(f.editor.buffer(target)!.disk.text, 'disk');
    f.editor.edit(target, 'disk');
    f.editor.edit(target, 'fresh visible tail');
    assert.equal(
      f.editor.getSnapshot().recoveryReady,
      false,
      'equal text cannot reuse old confirmation',
    );
    await f.editor.flush();
    const next = await f.restart();
    assert.equal(next.buffer(target)!.text, 'fresh visible tail');
    await next.dispose();
  } finally {
    await f.dispose();
  }
});

test('ordinary publication stays unready in flight and cannot confirm an edit made after capture', async () => {
  const f = await fixture();
  const hold = f.hold();
  try {
    f.editor.edit(target, 'captured');
    const flush = f.editor.flush();
    await hold.entered;
    assert.equal(f.editor.getSnapshot().publication, undefined);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    f.editor.edit(target, 'newer while publishing');
    hold.release();
    await flush;
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(
      (await f.raw.command('loadRecovery', { clientId: f.editor.clientId })).state.drafts[0].text,
      'captured',
    );
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const next = await f.restart();
    assert.equal(next.buffer(target)!.text, 'newer while publishing');
    await next.dispose();
  } finally {
    hold.release();
    await f.dispose();
  }
});

for (const committed of [false, true])
  test(`uncertain ${committed ? 'committed' : 'uncommitted'} publication retains identity and only confirms its captured generation`, async () => {
    const f = await fixture();
    try {
      f.editor.edit(target, 'original request');
      f.memory.failNext('persistRecovery', 'Lost response', committed);
      f.memory.failNext('getRecoveryPublication');
      await assert.rejects(f.editor.flush());
      const id = f.editor.getSnapshot().publication!.requestId;
      assert.equal(f.editor.getSnapshot().recoveryReady, false);
      f.editor.edit(target, 'later live draft');
      assert.equal(await f.editor.resolveRecoveryPublication(), true);
      assert.equal(f.editor.getSnapshot().recoveryReady, false);
      assert.equal(
        f.requests
          .filter((request) => request.requestId === id)
          .every((request) => request.state.drafts[0].text === 'original request'),
        true,
      );
      await f.editor.flush();
      assert.equal(f.editor.getSnapshot().recoveryReady, true);
      const next = await f.restart();
      assert.equal(next.buffer(target)!.text, 'later live draft');
      await next.dispose();
    } finally {
      await f.dispose();
    }
  });

test('read-only work and visible diagnostics do not invalidate confirmed recovery; view changes do', async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, 'durable dirty');
    await f.editor.flush();
    f.editor.report(Error('visible diagnostic'));
    await f.editor.list(checkout);
    await f.editor.lookup(checkout, 'a');
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.position(target, 'file', { line: 2, column: 3, top: 0, left: 0 });
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally {
    await f.dispose();
  }
});

test('even a publication of an already confirmed capture vetoes unload until its exact reply', async () => {
  const f = await fixture();
  const hold = f.hold();
  try {
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const writing = f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, false, 'queued publication is synchronous');
    await hold.entered;
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    hold.release();
    await writing;
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    await f.editor.dispose();
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.memory.stats.active, 0);
  } finally {
    hold.release();
    await f.dispose();
  }
});

test('an exact recovered receipt confirms unchanged dirty text without saving the file', async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, 'durable after lost response');
    f.memory.failNext('persistRecovery', 'Lost committed reply', true);
    f.memory.failNext('getRecoveryPublication');
    await assert.rejects(f.editor.flush());
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    assert.equal(f.memory.stats.saves, 0);
    assert.equal((await f.raw.command('readFile', target)).text, 'disk');
  } finally {
    await f.dispose();
  }
});

test('a definitively rejected ordinary publication invalidates earlier confirmation without adopting a foreign CAS revision', async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, 'confirmed dirty');
    await f.editor.flush();
    const loaded = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
    await f.raw.command('persistRecovery', {
      clientId: f.editor.clientId,
      requestId: crypto.randomUUID(),
      expectedRevision: loaded.revision,
      state: loaded.state,
    });
    await assert.rejects(f.editor.flush());
    assert.equal(f.editor.getSnapshot().publication, undefined);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await assert.rejects(f.editor.flush());
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(f.editor.buffer(target)!.text, 'confirmed dirty');
  } finally {
    await f.dispose();
  }
});

test('a held public read-only lookup does not veto an otherwise confirmed capture', async () => {
  const f = await fixture(),
    read = f.holdRead();
  try {
    const lookup = f.editor.lookup(checkout, 'a');
    await read.entered;
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    read.release();
    await lookup;
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally {
    read.release();
    await f.dispose();
  }
});

describe('recovery publication compatibility', () => {
  const { checkout, target, fixture } = controllerFixture;

  test('recovery publications bind canonical immutable input; retries/status do not write or adopt newer CAS', async () => {
    const f = await fixture('r4-publication-binding', false);
    try {
      await f.editor.flush();
      const loaded = await f.client.command('loadRecovery', { clientId: f.editor.clientId });
      const request = {
        clientId: f.editor.clientId,
        requestId: 'original',
        expectedRevision: loaded.revision,
        state: loaded.state,
      };
      const first = await f.client.command('persistRecovery', request);
      await f.client.command('persistRecovery', {
        ...request,
        requestId: 'later',
        expectedRevision: first.revision,
        state: { ...loaded.state, sidebarWidth: 351 },
      });
      const writes = f.memory.stats.publications;
      const reordered = {
        ...request,
        state: Object.fromEntries(Object.entries(request.state).reverse()) as typeof request.state,
      };
      assert.deepEqual(await f.client.command('persistRecovery', reordered), first);
      assert.deepEqual(
        await f.client.command('getRecoveryPublication', {
          clientId: request.clientId,
          requestId: request.requestId,
        }),
        first,
      );
      assert.equal(
        await f.client.command('getRecoveryPublication', {
          clientId: 'another',
          requestId: request.requestId,
        }),
        null,
      );
      assert.equal(f.memory.stats.publications, writes);
      for (const changed of [
        { ...request, expectedRevision: first.revision },
        { ...request, state: { ...request.state, sidebarWidth: 299 } },
      ])
        await assert.rejects(
          f.client.command('persistRecovery', changed),
          (error) => ApplicationError.is(error) && error.code === 'InvalidInput',
        );
      await assert.rejects(
        f.client.command('persistRecovery', { ...request, requestId: 'different' }),
        (error) => ApplicationError.is(error) && error.code === 'Conflict',
      );
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: request.clientId })).state.sidebarWidth,
        351,
      );
    } finally {
      await f.dispose();
    }
  });

  test('retry/status of an old publication cannot acknowledge a newer foreign operation', async () => {
    const f = await fixture('r4-publication-fence', false);
    try {
      await f.editor.open(target('a.ts'));
      await f.editor.flush();
      const loaded = await f.client.command('loadRecovery', { clientId: f.editor.clientId });
      const request = {
        clientId: f.editor.clientId,
        requestId: 'before-move',
        expectedRevision: loaded.revision,
        state: loaded.state,
      };
      await f.client.command('persistRecovery', request);
      const sources = await f.client.command('inspectEntries', { checkout, paths: ['a.ts'] });
      await f.client.command('mutate', {
        id: 'foreign-after-publication',
        clientId: 'foreign',
        checkout,
        sources,
        kind: 'move',
        destination: 'moved.ts',
      });
      await f.client.command('persistRecovery', request);
      await f.client.command('getRecoveryPublication', {
        clientId: request.clientId,
        requestId: request.requestId,
      });
      const ack = {
        clientId: request.clientId,
        operationClientId: 'foreign',
        id: 'foreign-after-publication',
      };
      await assert.rejects(
        f.client.command('acknowledgeOperation', ack),
        (error) => ApplicationError.is(error) && error.code === 'Conflict',
      );
      const latest = await f.client.command('loadRecovery', { clientId: request.clientId });
      await f.client.command('persistRecovery', {
        ...request,
        requestId: 'observed-move',
        expectedRevision: latest.revision,
        state: latest.state,
      });
      await f.client.command('acknowledgeOperation', ack);
    } finally {
      await f.dispose();
    }
  });
});
