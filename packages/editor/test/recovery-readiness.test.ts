import * as controllerFixture from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
  type CommandInput,
} from '@moonbase/application/client';
import { createEditor, fileKey } from '../src/editor.ts';
import { memoryWorkspace } from '../src/memory.ts';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'ready',
  projectId: 'project',
  root: '/memory/ready',
  branch: 'main',
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
  const editor = createEditor({ client, clientId: 'readiness' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.open(target);
  await editor.flush();
  return {
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
      editor.dispose();
      const next = createEditor({ client: raw, clientId: editor.clientId });
      await next.load();
      return next;
    },
    async dispose() {
      editor.dispose();
      await runtime.dispose();
    },
  };
}

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
    next.dispose();
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
    next.dispose();
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
      next.dispose();
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
    f.editor.dispose();
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

describe('controller preservation and activation', () => {
  const { checkout, second, target, fixture } = controllerFixture;
  for (const kind of ['files', 'checkout', 'quit'] as const)
    test(`${kind} preservation retains newer selection and unrelated metadata during publication`, async () => {
      const f = await fixture('r3-selection-' + kind, false);
      let hold = false,
        admit!: () => void,
        release!: () => void;
      const admitted = new Promise<void>((resolve) => {
          admit = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      let publications = 0;
      const client: EditorClient = {
        ...f.client,
        watch: () => () => {},
        async command(name, input, options) {
          if (hold && name === 'persistRecovery') {
            publications++;
            if (publications === 1) {
              admit();
              await wait;
            }
          }
          return f.client.command(name, input, options);
        },
      };
      let editor = createEditor({ client, clientId: f.editor.clientId });
      try {
        f.editor.dispose();
        await editor.load();
        await editor.openCheckout(checkout.root);
        await editor.open(target('a.ts'));
        await editor.open(target('b.ts'));
        await editor.openCheckout(second.root);
        editor.selectCheckout(checkout);
        await editor.flush();
        editor.dispose();
        editor = createEditor({ client, clientId: f.editor.clientId });
        await editor.load();
        assert.equal(editor.buffer(target('a.ts')), undefined);
        hold = true;
        let closing;
        if (kind === 'files') {
          closing = editor.close([target('b.ts')], async () => 'discard');
        } else {
          if (kind === 'checkout') {
            closing = editor.closeCheckout(checkout, async () => 'discard');
          } else {
            closing = editor.prepareQuit(async () => 'discard');
          }
        }
        await admitted;
        editor.selectCheckout(second);
        editor.tree(second, { focus: 'folder', expanded: ['folder'] });
        editor.resizeSidebar(321);
        release();
        assert.equal(await closing, true);
        const live = editor.getSnapshot().recovery,
          durable = await f.client.command('loadRecovery', { clientId: editor.clientId });
        for (const state of [live, durable.state]) {
          assert.equal(state.selectedCheckoutId, second.checkoutId);
          assert.equal(state.sidebarWidth, 321);
          assert.deepEqual(state.views[second.checkoutId].tree.expanded, ['folder']);
        }
        assert.equal(editor.buffer(target('a.ts')), undefined);
        assert.equal(publications, 3); // Retained drafts/metadata converge before one final close publication.
        if (kind === 'files') {
          assert.equal(await editor.open(target('a.ts')), true);
          assert.equal(editor.buffer(target('a.ts'))!.text, 'const a = 1;');
        }
      } finally {
        release();
        editor.dispose();
        await f.dispose();
      }
    });

  test('failed close publication keeps drafts and newer metadata without bypassing competing CAS', async () => {
    const f = await fixture('r3-failed-close', false);
    let hold = false,
      admit!: () => void,
      release!: () => void;
    const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const editor = createEditor({
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => () => {},
        async command(name, input, options) {
          if (hold && name === 'persistRecovery') {
            admit();
            await wait;
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'retained dirty text');
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      hold = true;
      const closing = editor.close([target('a.ts')], async () => 'discard');
      await admitted;
      editor.selectCheckout(second);
      editor.tree(second, { focus: 'folder' });
      const competing = await f.client.command('loadRecovery', { clientId: editor.clientId });
      await f.client.command('persistRecovery', {
        requestId: crypto.randomUUID(),
        clientId: editor.clientId,
        expectedRevision: competing.revision,
        state: { ...competing.state, sidebarWidth: 333 },
      });
      release();
      assert.equal(await closing, false);
      assert.equal(editor.buffer(target('a.ts'))!.text, 'retained dirty text');
      assert.equal(editor.getSnapshot().recovery.selectedCheckoutId, second.checkoutId);
      assert.equal(editor.getSnapshot().recovery.views[second.checkoutId].tree.focus, 'folder');
      await assert.rejects(
        editor.flush(),
        (error) => ApplicationError.is(error) && error.code === 'Conflict',
      );
      const durable = await f.client.command('loadRecovery', { clientId: editor.clientId });
      assert.equal(durable.state.sidebarWidth, 333);
      assert.equal(durable.state.drafts[0].text, 'retained dirty text');
    } finally {
      release();
      editor.dispose();
      await f.dispose();
    }
  });

  test('later close publication failure retains dirty buffers and can publish newer metadata at the actual revision', async () => {
    const f = await fixture('r3-later-publication', false);
    let hold = false,
      admit!: () => void,
      release!: () => void,
      publications = 0;
    const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const editor = createEditor({
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => () => {},
        async command(name, input, options) {
          if (hold && name === 'persistRecovery') {
            publications++;
            if (publications === 1) {
              admit();
              await wait;
            }
            if (publications === 2) throw Error('Later metadata publication failed');
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'keep until all publications succeed');
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      hold = true;
      const closing = editor.close([target('a.ts')], async () => 'discard');
      await admitted;
      editor.selectCheckout(second);
      editor.resizeSidebar(319);
      release();
      assert.equal(await closing, false);
      assert.equal(editor.buffer(target('a.ts'))!.text, 'keep until all publications succeed');
      assert.equal(editor.getSnapshot().recovery.selectedCheckoutId, second.checkoutId);
      assert.equal(await editor.resolveRecoveryPublication(), true);
      await editor.flush();
      const durable = await f.client.command('loadRecovery', { clientId: editor.clientId });
      assert.equal(durable.state.selectedCheckoutId, second.checkoutId);
      assert.equal(durable.state.sidebarWidth, 319);
      assert.equal(durable.state.drafts[0].text, 'keep until all publications succeed');
      assert.deepEqual(durable.state.views[checkout.checkoutId].openFiles, ['a.ts']);
    } finally {
      release();
      editor.dispose();
      await f.dispose();
    }
  });

  for (const kind of ['files', 'checkout', 'quit'] as const)
    for (const failure of ['conflict', 'lost response'] as const)
      test(`${kind} ${failure} at second publication cannot lose a persisted draft after failed close`, async () => {
        const f = await fixture('r4-durable-' + kind + failure, false);
        let hold = false,
          admit!: () => void,
          release!: () => void,
          calls = 0;
        const admitted = new Promise<void>((resolve) => {
            admit = resolve;
          }),
          wait = new Promise<void>((resolve) => {
            release = resolve;
          });
        const editor = createEditor({
          clientId: f.editor.clientId,
          client: {
            ...f.client,
            watch: () => () => {},
            async command(name, input, options) {
              if (hold && name === 'persistRecovery') {
                if (++calls === 1) {
                  admit();
                  await wait;
                } else if (calls === 2) {
                  if (failure === 'lost response')
                    f.memory.failNext('persistRecovery', 'Lost second publication response', true);
                  else {
                    const loaded = await f.client.command('loadRecovery', {
                      clientId: editor.clientId,
                    });
                    await f.client.command('persistRecovery', {
                      requestId: crypto.randomUUID(),
                      clientId: editor.clientId,
                      expectedRevision: loaded.revision,
                      state: { ...loaded.state, sidebarWidth: 355 },
                    });
                  }
                }
              }
              return f.client.command(name, input, options);
            },
          },
        });
        try {
          f.editor.dispose();
          await editor.load();
          await editor.openCheckout(checkout.root);
          await editor.open(target('b.ts'));
          editor.edit(target('b.ts'), 'previously persisted dirty draft');
          await editor.openCheckout(second.root);
          editor.selectCheckout(checkout);
          await editor.flush();
          hold = true;
          let closing;
          if (kind === 'files') {
            closing = editor.close([target('b.ts')], async () => 'discard');
          } else {
            if (kind === 'checkout') {
              closing = editor.closeCheckout(checkout, async () => 'discard');
            } else {
              closing = editor.prepareQuit(async () => 'discard');
            }
          }
          await admitted;
          editor.selectCheckout(second);
          editor.resizeSidebar(329);
          release();
          const closed = await closing;
          if (failure === 'conflict') assert.equal(closed, false);
          const durable = await f.client.command('loadRecovery', { clientId: editor.clientId });
          if (!closed) {
            assert.equal(
              durable.state.drafts.find((draft) => draft.target.path === 'b.ts')?.text,
              'previously persisted dirty draft',
            );
          } else {
            assert.equal(
              editor.buffer(target('b.ts'))?.text === 'previously persisted dirty draft',
              false,
            );
            assert.equal(durable.state.drafts.length, 0);
          }
          editor.dispose();
          const restarted = createEditor({
            clientId: editor.clientId,
            client: { ...f.client, watch: () => () => {} },
          });
          try {
            await restarted.load();
            if (closed)
              assert.notEqual(
                restarted.buffer(target('b.ts'))?.text,
                'previously persisted dirty draft',
              );
            else
              assert.equal(
                restarted.buffer(target('b.ts'))?.text,
                'previously persisted dirty draft',
              );
          } finally {
            restarted.dispose();
          }
        } finally {
          release();
          editor.dispose();
          await f.dispose();
        }
      });

  test('selecting a background-closed checkout loads its absent survivor in its remembered view', async () => {
    const f = await fixture('r4-background', false);
    let hold = false,
      admit!: () => void,
      release!: () => void;
    const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    let delayRead = false,
      reading!: () => void,
      finishRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      }),
      readWait = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
    let editor = createEditor({
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => () => {},
        async command(name, input, options) {
          if (hold && name === 'persistRecovery') {
            admit();
            await wait;
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'), { view: 'staged' });
      await editor.open(target('b.ts'));
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      editor.dispose();
      editor = createEditor({
        clientId: editor.clientId,
        client: {
          ...f.client,
          watch: () => () => {},
          async command(name, input, options) {
            if (hold && name === 'persistRecovery') {
              admit();
              await wait;
            }
            if (delayRead && name === 'readComparison') {
              reading();
              await readWait;
            }
            return f.client.command(name, input, options);
          },
        },
      });
      await editor.load();
      assert.equal(editor.buffer(target('a.ts')), undefined);
      hold = true;
      const closing = editor.close([target('b.ts')], async () => 'discard');
      await admitted;
      editor.selectCheckout(second);
      release();
      assert.equal(await closing, true);
      f.memory.externalWrite(target('a.ts'), 'current source after close');
      delayRead = true;
      const selecting = editor.selectCheckout(checkout);
      await readStarted;
      await editor.selectCheckout(second);
      finishRead();
      assert.equal(await selecting, false);
      assert.equal(editor.getSnapshot().recovery.selectedCheckoutId, second.checkoutId);
      assert.equal(editor.buffer(target('a.ts')), undefined);
      delayRead = false;
      await editor.selectCheckout(checkout);
      assert.equal(editor.buffer(target('a.ts'))?.text, 'current source after close');
      assert.equal(
        editor.getSnapshot().recovery.views[checkout.checkoutId].fileViews['a.ts'],
        'staged',
      );
      assert.equal(
        editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
        'const a = 0;',
      );
    } finally {
      release();
      finishRead();
      editor.dispose();
      await f.dispose();
    }
  });

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

  for (const outcome of ['not committed', 'committed', 'competing CAS'] as const)
    test(`exact resolution of an uncertain final close (${outcome}) preserves the durable outcome and original request`, async () => {
      const f = await fixture('r4-final-' + outcome, false);
      let armed = false,
        failed = false;
      const requests: CommandInput<'persistRecovery'>[] = [];
      const editor = createEditor({
        clientId: f.editor.clientId,
        client: {
          ...f.client,
          watch: () => () => {},
          async command(name, input, options) {
            if (armed && name === 'persistRecovery') {
              const request = input as CommandInput<'persistRecovery'>;
              requests.push(structuredClone(request));
              if (!request.state.drafts.length && !failed) {
                failed = true;
                if (outcome === 'committed') await f.client.command(name, input, options);
                f.memory.failNext('getRecoveryPublication');
                throw new ApplicationError({
                  code: 'Unavailable',
                  message: 'Final close response unavailable',
                });
              }
            }
            return f.client.command(name, input, options);
          },
        },
      });
      try {
        f.editor.dispose();
        await editor.load();
        await editor.openCheckout(checkout.root);
        await editor.open(target('b.ts'));
        editor.edit(target('b.ts'), 'consented captured draft');
        await editor.flush();
        armed = true;
        assert.equal(await editor.close([target('b.ts')], async () => 'discard'), false);
        const pending = editor.getSnapshot().publication;
        assert.equal(pending?.kind, 'close');
        assert.equal(editor.getSnapshot().preserving, true);
        assert.equal(editor.buffer(target('b.ts'))?.text, 'consented captured draft');
        assert.equal(await editor.prepareQuit(async () => 'discard'), false);
        assert.equal(await editor.save(target('b.ts')), false);
        assert.equal(await editor.reload(target('b.ts')), false);
        await assert.rejects(editor.flush());
        assert.throws(() => editor.edit(target('b.ts'), 'must not be silently discarded'));
        await assert.rejects(
          editor.mutate({ checkout, kind: 'create-file', sources: [], destination: 'blocked.ts' }),
        );
        const stored = await f.client.command('loadRecovery', { clientId: editor.clientId });
        const restarted = createEditor({
          clientId: editor.clientId,
          client: { ...f.client, watch: () => () => {} },
        });
        try {
          await restarted.load();
          assert.equal(
            restarted.buffer(target('b.ts'))?.text,
            outcome === 'committed' ? undefined : 'consented captured draft',
          );
        } finally {
          restarted.dispose();
        }
        if (outcome === 'competing CAS')
          await f.client.command('persistRecovery', {
            clientId: editor.clientId,
            requestId: 'competitor',
            expectedRevision: stored.revision,
            state: { ...stored.state, sidebarWidth: 356 },
          });
        const writes = f.memory.stats.publications;
        assert.equal(await editor.resolveRecoveryPublication(), outcome !== 'competing CAS');
        if (outcome === 'competing CAS') {
          // The identical retry's Conflict proves non-commit; the unrelated revision still cannot be adopted.
          assert.equal(editor.getSnapshot().publication, undefined);
          assert.equal(editor.getSnapshot().preserving, false);
          assert.equal(editor.buffer(target('b.ts'))?.text, 'consented captured draft');
          let choices = 0;
          assert.equal(
            await editor.close([target('b.ts')], async () => {
              choices++;
              return 'cancel';
            }),
            false,
          );
          assert.equal(choices, 1);
          assert.equal(await editor.prepareQuit(async () => 'discard'), false);
          const retained = await f.client.command('loadRecovery', { clientId: editor.clientId });
          assert.equal(retained.state.drafts[0].text, 'consented captured draft');
          assert.equal(retained.state.sidebarWidth, 356);
          assert.equal(f.memory.stats.publications, writes);
          assert.equal(
            await f.client.command('getRecoveryPublication', {
              clientId: editor.clientId,
              requestId: pending!.requestId,
            }),
            null,
          );
        } else {
          assert.equal(editor.getSnapshot().publication, undefined);
          assert.equal(editor.getSnapshot().preserving, false);
          assert.equal(editor.buffer(target('b.ts')), undefined);
          assert.equal(f.memory.stats.publications, writes + Number(outcome === 'not committed'));
        }
        const final = requests.filter((request) => !request.state.drafts.length);
        assert.equal(final.length, outcome === 'committed' ? 1 : 2);
        assert(final.every((request) => JSON.stringify(request) === JSON.stringify(final[0])));
        assert.equal(final[0].requestId, pending?.requestId);
      } finally {
        editor.dispose();
        await f.dispose();
      }
    });

  test('later metadata failure cannot veto a final close already confirmed by exact receipt', async () => {
    const f = await fixture('r4-committed-close', false);
    let armed = false,
      publications = 0;
    const editor = createEditor({
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => () => {},
        async command(name, input, options) {
          if (armed && name === 'persistRecovery' && ++publications === 2) {
            const receipt = await f.client.command(name, input, options);
            editor.resizeSidebar(318);
            f.memory.failNext('persistRecovery', 'Later unrelated metadata unavailable');
            return receipt;
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('b.ts'));
      editor.edit(target('b.ts'), 'committed discard');
      await editor.flush();
      armed = true;
      assert.equal(await editor.close([target('b.ts')], async () => 'discard'), true);
      assert.equal(editor.buffer(target('b.ts')), undefined);
      assert.equal(editor.getSnapshot().recovery.sidebarWidth, 318);
      await assert.rejects(editor.flush());
      assert.equal(editor.buffer(target('b.ts')), undefined);
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: editor.clientId })).state.drafts.length,
        0,
      );
    } finally {
      editor.dispose();
      await f.dispose();
    }
  });

  const held = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  async function observedFixture(clientId: string) {
    const f = await fixture(clientId, false);
    await f.editor.open(target('a.ts'), { view: 'staged' });
    await f.editor.open(target('b.ts'));
    await f.editor.openCheckout(second.root);
    await f.editor.open(target('a.ts', second));
    await f.editor.open(target('b.ts', second));
    await f.editor.selectCheckout(checkout);
    await f.editor.flush();
    f.editor.dispose();
    const transport: { command?: EditorClient['command'] } = {};
    const client: EditorClient = {
      ...f.client,
      watch: () => () => {},
      command(name, input, options) {
        return transport.command
          ? transport.command(name, input, options)
          : f.client.command(name, input, options);
      },
    };
    const editor = createEditor({ client, clientId });
    await editor.load();
    return {
      ...f,
      raw: f.client,
      clientCommand: f.client.command,
      editor,
      client,
      transport,
      async dispose() {
        editor.dispose();
        await f.dispose();
      },
    };
  }

  test("an observation already awaiting recovery cannot remap Reload's captured draft or erase it on restart", async () => {
    const f = await observedFixture('r5-reload-observation'),
      observing = held(),
      allowObservation = held(),
      reading = held(),
      allowRead = held();
    try {
      await f.editor.open(target('a.ts'), { view: 'file' });
      f.editor.edit(target('a.ts'), 'precious moved draft');
      await f.editor.flush();
      let delayObservation = true,
        delayRead = true;
      f.transport.command = async (name, input, options) => {
        if (name === 'loadRecovery' && delayObservation) {
          delayObservation = false;
          observing.release();
          await allowObservation.promise;
        }
        const result = await f.clientCommand(name, input, options);
        if (name === 'readFile' && delayRead) {
          delayRead = false;
          reading.release();
          await allowRead.promise;
        }
        return result;
      };
      const observation = f.editor.reconcileRecovery();
      await observing.promise;
      const reload = f.editor.reload(target('a.ts'));
      await reading.promise;
      const sources = await f.raw.command('inspectEntries', { checkout, paths: ['a.ts'] });
      await f.raw.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: 'during-reload',
        sources,
        kind: 'move',
        destination: 'renamed.ts',
      });
      allowObservation.release();
      await observation;
      allowRead.release();
      await reload.catch(() => false);
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      assert.equal(f.editor.buffer(target('renamed.ts'))?.text, 'precious moved draft');
      assert.equal(
        (await f.raw.command('loadRecovery', { clientId: f.editor.clientId })).state.drafts[0].text,
        'precious moved draft',
      );
      f.editor.dispose();
      const restarted = createEditor({
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => () => {} },
      });
      try {
        await restarted.load();
        assert.equal(restarted.buffer(target('renamed.ts'))?.text, 'precious moved draft');
      } finally {
        restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      allowObservation.release();
      allowRead.release();
      await f.dispose();
    }
  });

  test('an older observation cannot resurrect a consented draft around an uncertain final close receipt', async () => {
    const f = await observedFixture('r5-close-observation'),
      observing = held(),
      allowObservation = held();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'consented captured draft');
      await f.editor.flush();
      let delayObservation = true,
        loseFinal = true,
        statusDown = true;
      f.transport.command = async (name, input, options) => {
        if (name === 'loadRecovery' && delayObservation) {
          delayObservation = false;
          observing.release();
          await allowObservation.promise;
        }
        if (
          name === 'persistRecovery' &&
          loseFinal &&
          !(input as CommandInput<'persistRecovery'>).state.views[
            checkout.checkoutId
          ].openFiles.includes('a.ts')
        ) {
          loseFinal = false;
          await f.clientCommand(name, input, options);
          throw new ApplicationError({ code: 'Uncertain', message: 'Lost final receipt' });
        }
        if (name === 'getRecoveryPublication' && statusDown) throw Error('Status unavailable');
        return f.clientCommand(name, input, options);
      };
      const observation = f.editor.reconcileRecovery();
      await observing.promise;
      assert.equal(await f.editor.close([target('a.ts')], async () => 'discard'), false);
      const sources = await f.raw.command('inspectEntries', { checkout, paths: ['a.ts'] });
      await f.raw.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: 'after-commit',
        sources,
        kind: 'move',
        destination: 'renamed.ts',
      });
      allowObservation.release();
      await observation.catch(() => {});
      statusDown = false;
      assert.equal(await f.editor.resolveRecoveryPublication(), true);
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      assert.equal(
        f.editor.getSnapshot().buffers.some((buffer) => buffer.text === 'consented captured draft'),
        false,
      );
      assert.equal(
        f.editor.getSnapshot().recovery.views[checkout.checkoutId].openFiles.includes('renamed.ts'),
        false,
      );
      const durable = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(durable.state.drafts.length, 0);
      assert.equal(durable.operations.length, 0);
      f.editor.dispose();
      const restarted = createEditor({
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => () => {} },
      });
      try {
        await restarted.load();
        assert.equal(
          restarted
            .getSnapshot()
            .buffers.some((buffer) => buffer.text === 'consented captured draft'),
          false,
        );
      } finally {
        restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      allowObservation.release();
      await f.dispose();
    }
  });

  for (const outcome of ['success', 'cancel', 'failure', 'unknown'] as const)
    test(`a selected absent survivor activates after another preservation releases (${outcome})`, async () => {
      const f = await observedFixture('r5-selected-' + outcome);
      let entered = held(),
        release = held(),
        delay = true,
        phase = 1,
        lost = false;
      try {
        f.transport.command = async (name, input, options) => {
          if (name === 'persistRecovery' && delay) {
            delay = false;
            entered.release();
            await release.promise;
            if (phase === 2 && outcome === 'failure')
              throw new ApplicationError({
                code: 'Conflict',
                message: 'Definitive preflight conflict',
              });
          }
          if (
            name === 'persistRecovery' &&
            phase === 2 &&
            outcome === 'unknown' &&
            !(input as CommandInput<'persistRecovery'>).state.views[
              second.checkoutId
            ].openFiles.includes('b.ts') &&
            !lost
          ) {
            lost = true;
            await f.clientCommand(name, input, options);
            f.memory.failNext('getRecoveryPublication');
            throw Error('Lost final reply');
          }
          return f.clientCommand(name, input, options);
        };
        const firstClose = f.editor.close([target('b.ts')], async () => 'discard');
        await entered.promise;
        await f.editor.selectCheckout(second);
        release.release();
        assert.equal(await firstClose, true);
        assert.equal(f.editor.buffer(target('a.ts')), undefined);
        phase = 2;
        entered = held();
        release = held();
        delay = true;
        if (outcome === 'cancel') {
          delay = false;
          f.editor.edit(target('b.ts', second), 'retain on cancel');
        }
        const secondClose = f.editor.close([target('b.ts', second)], async () => {
          if (outcome === 'cancel') {
            entered.release();
            await release.promise;
            return 'cancel';
          }
          return 'discard';
        });
        await entered.promise;
        await f.editor.selectCheckout(checkout);
        f.memory.externalWrite(target('a.ts'), 'latest selected source');
        release.release();
        assert.equal(await secondClose, outcome === 'success');
        if (outcome === 'unknown') {
          assert.equal(f.editor.buffer(target('a.ts')), undefined);
          assert.equal(await f.editor.resolveRecoveryPublication(), true);
        }
        assert.equal(f.editor.getSnapshot().recovery.selectedCheckoutId, checkout.checkoutId);
        assert.equal(f.editor.buffer(target('a.ts'))?.text, 'latest selected source');
        assert.equal(
          f.editor.getSnapshot().recovery.views[checkout.checkoutId].fileViews['a.ts'],
          'staged',
        );
      } finally {
        release.release();
        await f.dispose();
      }
    });

  test('a captured Save remains a fact while new foreign remaps wait for preservation release', async () => {
    const f = await observedFixture('r5-captured-save');
    let move = true;
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'saved before cancel');
      f.editor.edit(target('b.ts'), 'retained moved sibling');
      await f.editor.flush();
      f.transport.command = async (name, input, options) => {
        const result = await f.clientCommand(name, input, options);
        if (name === 'saveFile' && move) {
          move = false;
          const sources = await f.raw.command('inspectEntries', { checkout, paths: ['b.ts'] });
          await f.raw.command('mutate', {
            checkout,
            clientId: 'foreign',
            id: 'during-captured-save',
            sources,
            kind: 'move',
            destination: 'renamed.ts',
          });
        }
        return result;
      };
      assert.equal(
        await f.editor.close([target('a.ts'), target('b.ts')], async (buffer) =>
          buffer.target.path === 'a.ts' ? 'save' : 'cancel',
        ),
        false,
      );
      await f.editor.reconcileRecovery();
      assert.equal(f.editor.buffer(target('a.ts'))?.disk.text, 'saved before cancel');
      assert.equal((await f.raw.command('readFile', target('a.ts'))).text, 'saved before cancel');
      assert.equal(f.editor.buffer(target('renamed.ts'))?.text, 'retained moved sibling');
      const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(
        stored.state.drafts.find((draft) => draft.target.path === 'renamed.ts')?.text,
        'retained moved sibling',
      );
      assert.equal(stored.operations.length, 0);
      assert.equal(f.memory.stats.saves, 1);
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      await f.dispose();
    }
  });

  test('an admitted observer acknowledgement stays completed when its response crosses a Reload lock', async () => {
    const f = await observedFixture('r5-ack-boundary'),
      acked = held(),
      releaseAck = held(),
      reading = held(),
      releaseRead = held();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'acknowledged dirty draft');
      await f.editor.flush();
      const sources = await f.raw.command('inspectEntries', { checkout, paths: ['a.ts'] });
      await f.raw.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: 'ack-before-capture',
        sources,
        kind: 'move',
        destination: 'renamed.ts',
      });
      let holdAck = true,
        holdRead = true;
      f.transport.command = async (name, input, options) => {
        const result = await f.clientCommand(name, input, options);
        if (name === 'acknowledgeOperation' && holdAck) {
          holdAck = false;
          acked.release();
          await releaseAck.promise;
        }
        if (name === 'readFile' && holdRead) {
          holdRead = false;
          reading.release();
          await releaseRead.promise;
        }
        return result;
      };
      const observing = f.editor.reconcileRecovery();
      await acked.promise;
      const reloading = f.editor.reload(target('b.ts'));
      await reading.promise;
      releaseAck.release();
      await observing;
      releaseRead.release();
      assert.equal(await reloading, true);
      await f.editor.reconcileRecovery();
      assert.equal(f.editor.getSnapshot().operations.length, 0);
      const durable = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(durable.operations.length, 0);
      assert.equal(durable.state.drafts[0].text, 'acknowledged dirty draft');
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      releaseAck.release();
      releaseRead.release();
      await f.dispose();
    }
  });

  test('a confirmed destination close invalidates an older Copy materialization across retry and restart', async () => {
    const f = await observedFixture('r6-copy-close'),
      preflight = held(),
      releasePreflight = held(),
      reading = held(),
      releaseRead = held();
    try {
      await f.editor.open(target('a.ts'), { view: 'file' });
      await f.editor.open(target('b.ts'));
      await f.editor.flush();
      const sources = await f.editor.inspect(checkout, ['a.ts']);
      let delayPreflight = true,
        delayRead = true;
      f.transport.command = async (name, input, options) => {
        const result = await f.clientCommand(name, input, options);
        if (name === 'persistRecovery' && delayPreflight) {
          delayPreflight = false;
          preflight.release();
          await releasePreflight.promise;
        }
        if (
          name === 'readFile' &&
          (input as CommandInput<'readFile'>).path === 'copy.ts' &&
          delayRead
        ) {
          delayRead = false;
          reading.release();
          await releaseRead.promise;
        }
        return result;
      };
      const copying = f.editor.mutate({ checkout, kind: 'copy', sources, destination: 'copy.ts' });
      await preflight.promise;
      f.editor.edit(target('a.ts'), 'source changed after preflight');
      releasePreflight.release();
      await reading.promise;
      assert.equal(await f.editor.open(target('copy.ts')), true);
      f.editor.edit(target('copy.ts'), 'destination edits discarded');
      assert.equal(await f.editor.close([target('copy.ts')], async () => 'discard'), true);
      assert.equal(f.editor.buffer(target('copy.ts')), undefined);
      assert.equal(
        (await f.raw.command('loadRecovery', { clientId: f.editor.clientId })).state.drafts.some(
          (draft) => draft.target.path === 'copy.ts',
        ),
        false,
      );
      releaseRead.release();
      await copying;
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      const live = f.editor.buffer(target('copy.ts')),
        stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      f.editor.dispose();
      const restarted = createEditor({
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => () => {} },
      });
      try {
        await restarted.load();
        assert.equal(stored.operations.length, 0);
        assert.equal(f.memory.stats.mutations, 1);
        assert.equal(live, undefined);
        assert.equal(restarted.buffer(target('copy.ts')), undefined);
        assert.equal(
          stored.state.drafts.some((draft) => draft.target.path === 'copy.ts'),
          false,
        );
        assert.equal(stored.state.views[checkout.checkoutId].openFiles.includes('copy.ts'), false);
        assert.equal((await f.raw.command('readFile', target('copy.ts'))).text, 'const a = 1;');
      } finally {
        restarted.dispose();
      }
    } finally {
      releasePreflight.release();
      releaseRead.release();
      await f.dispose();
    }
  });

  for (const area of ['staged', 'unstaged'] as const)
    test(`restored dirty ${area} survivor loads its remembered comparison`, async () => {
      const f = await observedFixture('r6-dirty-' + area);
      let restarted: ReturnType<typeof createEditor> | undefined;
      try {
        await f.editor.open(target('a.ts'), { view: area });
        f.editor.edit(target('a.ts'), 'restored dirty comparison');
        const baseline = f.editor.buffer(target('a.ts'))!.disk;
        await f.editor.open(target('b.ts'));
        await f.editor.flush();
        f.editor.dispose();
        f.memory.externalWrite(target('a.ts'), 'new external working content');
        restarted = createEditor({ clientId: f.editor.clientId, client: f.client });
        await restarted.load();
        assert.equal(restarted.getSnapshot().comparisons[fileKey(target('a.ts'))], undefined);
        assert.equal(await restarted.close([target('b.ts')], async () => 'discard'), true);
        assert.equal(
          restarted.getSnapshot().comparisons[fileKey(target('a.ts'))]?.original,
          area === 'staged' ? 'const a = 0;' : 'const a = 0.5;',
        );
        assert.equal(restarted.buffer(target('a.ts'))!.text, 'restored dirty comparison');
        assert.deepEqual(restarted.buffer(target('a.ts'))!.disk, baseline);
        assert.equal(
          restarted.buffer(target('a.ts'))!.conflict?.text,
          'new external working content',
        );
      } finally {
        restarted?.dispose();
        await f.dispose();
      }
    });

  for (const outcome of ['cancel', 'failure', 'reopen', 'unrelated'] as const)
    test(`Copy target invalidation preserves newer intent without cancelling other targets (${outcome})`, async () => {
      const f = await observedFixture('r6-copy-' + outcome),
        preflight = held(),
        releasePreflight = held(),
        reading = held(),
        releaseRead = held();
      const source = outcome === 'unrelated' ? 'folder/nested.ts' : 'a.ts',
        copied = outcome === 'unrelated' ? 'folder-copy/nested.ts' : 'copy.ts';
      try {
        await f.editor.open(target(source), { view: 'file' });
        await f.editor.flush();
        const sources = await f.editor.inspect(checkout, [
          outcome === 'unrelated' ? 'folder' : source,
        ]);
        let delayPreflight = true,
          delayRead = true,
          failClose = false;
        f.transport.command = async (name, input, options) => {
          if (name === 'persistRecovery' && failClose) {
            failClose = false;
            throw new ApplicationError({ code: 'Conflict', message: 'Close not admitted' });
          }
          const result = await f.clientCommand(name, input, options);
          if (name === 'persistRecovery' && delayPreflight) {
            delayPreflight = false;
            preflight.release();
            await releasePreflight.promise;
          }
          if (
            name === 'readFile' &&
            (input as CommandInput<'readFile'>).path === copied &&
            delayRead
          ) {
            delayRead = false;
            reading.release();
            await releaseRead.promise;
          }
          return result;
        };
        const copying = f.editor.mutate({
          checkout,
          kind: 'copy',
          sources,
          destination: outcome === 'unrelated' ? 'folder-copy' : copied,
        });
        await preflight.promise;
        f.editor.edit(target(source), 'source changed after preflight');
        releasePreflight.release();
        await reading.promise;
        const closing = outcome === 'unrelated' ? 'a.ts' : copied;
        await f.editor.open(target(closing), { view: 'file' });
        f.editor.edit(target(closing), 'current destination edits');
        failClose = outcome === 'failure';
        assert.equal(
          await f.editor.close([target(closing)], async () =>
            outcome === 'cancel' ? 'cancel' : 'discard',
          ),
          outcome === 'reopen' || outcome === 'unrelated',
        );
        if (outcome === 'reopen') {
          await f.editor.open(target(copied));
          f.editor.edit(target(copied), 'later explicit edits');
        }
        releaseRead.release();
        await copying;
        await f.editor.reconcileRecovery();
        await f.editor.flush();
        let expected;
        if (outcome === 'reopen') {
          expected = 'later explicit edits';
        } else {
          if (outcome === 'unrelated') {
            expected = 'source changed after preflight';
          } else {
            expected = 'current destination edits';
          }
        }
        assert.equal(f.editor.buffer(target(copied))?.text, expected);
        const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
        assert.equal(
          stored.state.drafts.find((draft) => draft.target.path === copied)?.text,
          expected,
        );
        assert.equal(stored.operations.length, 0);
        assert.equal(f.memory.stats.mutations, 1);
      } finally {
        releasePreflight.release();
        releaseRead.release();
        await f.dispose();
      }
    });

  for (const area of ['staged', 'untracked'] as const)
    test(`settled ${area} comparison activation does not retry on every release`, async () => {
      const f = await observedFixture('r6-comparison-ready-' + area);
      let restarted: ReturnType<typeof createEditor> | undefined,
        reads = 0;
      try {
        await f.editor.open(target('a.ts'), { view: area });
        f.editor.edit(target('a.ts'), 'retained dirty text');
        await f.editor.open(target('b.ts'));
        await f.editor.flush();
        f.editor.dispose();
        f.transport.command = async (name, input, options) => {
          if (name === 'readComparison') reads++;
          return f.clientCommand(name, input, options);
        };
        restarted = createEditor({ clientId: f.editor.clientId, client: f.client });
        await restarted.load();
        if (area === 'staged') f.memory.failNext('readComparison', 'Controlled comparison failure');
        assert.equal(await restarted.close([target('b.ts')], async () => 'discard'), true);
        const attempts = reads;
        await restarted.selectCheckout(checkout);
        assert.equal(await restarted.prepareQuit(async () => 'cancel'), false);
        assert.equal(reads, attempts);
        assert.equal(restarted.buffer(target('a.ts'))?.text, 'retained dirty text');
        if (area === 'untracked')
          assert.equal(restarted.getSnapshot().comparisons[fileKey(target('a.ts'))]?.original, '');
        else {
          assert(
            restarted
              .getSnapshot()
              .errors.some((error) => error.includes('Comparison unavailable')),
          );
          assert.equal(await restarted.open(target('a.ts')), true);
          assert.equal(reads, attempts + 1);
          assert.equal(
            restarted.getSnapshot().comparisons[fileKey(target('a.ts'))]?.original,
            'const a = 0;',
          );
        }
      } finally {
        restarted?.dispose();
        await f.dispose();
      }
    });

  async function missingWorkingFixture(area: 'staged' | 'unstaged' | 'untracked') {
    const memory = memoryWorkspace([
      {
        checkout,
        files: { 'b.ts': 'other file' },
        head: { 'a.ts': 'HEAD A' },
        index: { 'a.ts': 'INDEX A' },
      },
      { checkout: second, files: { 'b.ts': 'second checkout' } },
    ]);
    const runtime = ManagedRuntime.make(memory.layer),
      raw = makeEditorClient(runtime);
    let reads = 0;
    const client: EditorClient = {
      ...raw,
      watch: () => () => {},
      command(name, input, options) {
        if (name === 'readComparison') reads++;
        return raw.command(name, input, options);
      },
    };
    const editor = createEditor({ client, clientId: 'r7-working-' + area });
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'), { view: area });
    return {
      editor,
      raw,
      memory,
      get reads() {
        return reads;
      },
      async recreate() {
        await raw.command('mutate', {
          checkout,
          clientId: 'foreign',
          id: 'recreate-' + area,
          kind: 'create-file',
          sources: [],
          destination: 'a.ts',
          text: 'RECREATED WORKING FILE',
        });
      },
      async dispose() {
        editor.dispose();
        await runtime.dispose();
      },
    };
  }

  for (const area of ['staged', 'unstaged'] as const)
    test(`missing ${area} working document becomes editable after recreation and refresh`, async () => {
      const f = await missingWorkingFixture(area);
      try {
        assert.equal(f.editor.buffer(target('a.ts')), undefined);
        assert.equal(f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].working, null);
        await f.editor.openCheckout(second.root);
        await f.recreate();
        await f.editor.refresh(checkout);
        assert.equal(
          f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].working?.text,
          'RECREATED WORKING FILE',
        );
        await f.editor.selectCheckout(checkout);
        await f.editor.refresh(checkout);
        assert.equal(f.editor.buffer(target('a.ts'))?.text, 'RECREATED WORKING FILE');
        assert.equal(
          f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
          area === 'staged' ? 'HEAD A' : 'INDEX A',
        );
        f.editor.edit(target('a.ts'), 'typed after recreation');
        assert.equal(await f.editor.save(target('a.ts')), true);
        assert.equal(
          (await f.raw.command('readFile', target('a.ts'))).text,
          'typed after recreation',
        );
      } finally {
        await f.dispose();
      }
    });

  test('persistent missing and failed working activation settle until a newer document is observed', async () => {
    const f = await missingWorkingFixture('staged');
    try {
      await f.editor.openCheckout(second.root);
      await f.editor.open(target('b.ts', second));
      f.editor.edit(target('b.ts', second), 'cancel this other draft');
      await f.editor.selectCheckout(checkout);
      const missingReads = f.reads;
      for (let attempt = 0; attempt < 2; attempt++) {
        await f.editor.selectCheckout(checkout);
        assert.equal(await f.editor.close([target('b.ts', second)], async () => 'cancel'), false);
      }
      assert.equal(f.reads, missingReads);
      assert.equal(f.editor.buffer(target('a.ts')), undefined);
      await f.editor.selectCheckout(second);
      await f.recreate();
      await f.editor.refresh(checkout);
      f.memory.failNext('readComparison', 'Working activation unavailable');
      const beforeFailure = f.reads;
      assert.equal(await f.editor.selectCheckout(checkout), false);
      assert.equal(f.reads, beforeFailure + 1);
      const failedReads = f.reads;
      for (let attempt = 0; attempt < 2; attempt++) {
        await f.editor.selectCheckout(checkout);
        assert.equal(await f.editor.close([target('b.ts', second)], async () => 'cancel'), false);
      }
      assert.equal(f.reads, failedReads);
      assert.equal(f.editor.buffer(target('a.ts')), undefined);
      const disk = await f.raw.command('readFile', target('a.ts'));
      await f.raw.command('saveFile', {
        clientId: 'foreign',
        requestId: 'new-working-version',
        target: target('a.ts'),
        text: 'NEW WORKING VERSION',
        expectedVersion: disk.version,
      });
      await f.editor.refresh(checkout);
      await f.editor.selectCheckout(checkout);
      assert.equal(f.editor.buffer(target('a.ts'))?.text, 'NEW WORKING VERSION');
      const baseline = f.editor.buffer(target('a.ts'))!.disk;
      f.editor.edit(target('a.ts'), 'retained new dirty text');
      await f.raw.command('saveFile', {
        clientId: 'foreign',
        requestId: 'later-working-version',
        target: target('a.ts'),
        text: 'LATER EXTERNAL VERSION',
        expectedVersion: baseline.version,
      });
      await f.editor.refresh(checkout);
      await f.editor.selectCheckout(checkout);
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'retained new dirty text');
      assert.deepEqual(f.editor.buffer(target('a.ts'))!.disk, baseline);
      assert.equal(await f.editor.save(target('a.ts')), false);
      assert.equal(f.editor.buffer(target('a.ts'))!.conflict?.text, 'LATER EXTERNAL VERSION');
    } finally {
      await f.dispose();
    }
  });

  test('an empty original remains settled while missing and editable after recreation', async () => {
    const f = await missingWorkingFixture('untracked');
    try {
      const initialReads = f.reads;
      assert.equal(f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original, '');
      await f.editor.selectCheckout(checkout);
      await f.editor.selectCheckout(checkout);
      assert.equal(f.reads, initialReads);
      await f.editor.openCheckout(second.root);
      await f.recreate();
      await f.editor.refresh(checkout);
      await f.editor.selectCheckout(checkout);
      assert.equal(f.editor.buffer(target('a.ts'))?.text, 'RECREATED WORKING FILE');
      const readyReads = f.reads;
      await f.editor.selectCheckout(checkout);
      assert.equal(f.reads, readyReads);
      assert.equal(f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original, '');
    } finally {
      await f.dispose();
    }
  });

  for (const area of ['staged', 'unstaged'] as const)
    test(`selected ${area} refresh installs a newly available working buffer`, async () => {
      const f = await missingWorkingFixture(area);
      try {
        await f.recreate();
        await f.editor.refresh(checkout);
        assert.equal(f.editor.getSnapshot().recovery.selectedCheckoutId, checkout.checkoutId);
        assert.equal(f.editor.buffer(target('a.ts'))?.text, 'RECREATED WORKING FILE');
        f.editor.edit(target('a.ts'), 'editable without changing checkout');
        assert.equal(await f.editor.save(target('a.ts')), true);
        assert.equal(
          (await f.raw.command('readFile', target('a.ts'))).text,
          'editable without changing checkout',
        );
      } finally {
        await f.dispose();
      }
    });
});
