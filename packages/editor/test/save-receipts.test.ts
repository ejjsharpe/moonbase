import { acquireEditor, answering } from './model-fixture.ts';
import * as controllerFixture from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type EditorClient,
} from '@moonbase/application/client';
import { type EditorController } from '@moonbase/editor/state';
import { memoryWorkspace } from '@moonbase/editor/memory';

const checkout: CheckoutTarget = {
  hostId: 'receipts',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/receipt-fixture',
  branch: 'main',
};
const target = (path: string) => ({ checkout, path });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function fixture(wrap: (raw: EditorClient) => EditorClient = (raw) => raw) {
  const memory = memoryWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' } }]);
  const runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime),
    client = wrap(raw);
  const editor = await acquireEditor(runtime, { client, clientId: 'only-client' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  for (const path of ['a.ts', 'b.ts', 'c.ts']) {
    await editor.open(target(path));
    editor.edit(target(path), 'captured ' + path);
  }
  await editor.flush();
  const restarted: EditorController[] = [];
  return {
    memory,
    runtime,
    raw,
    editor,
    async restart() {
      await editor.dispose();
      const next = await acquireEditor(runtime, { client: raw, clientId: editor.clientId });
      restarted.push(next);
      await next.load();
      return next;
    },
    async dispose() {
      await editor.dispose();
      for (const next of restarted) await next.dispose();
      await runtime.dispose();
      assert.equal(memory.stats.active, 0);
      assert.equal(memory.stats.subscriptions, memory.stats.released);
    },
  };
}
for (const observe of [false, true])
  test(`lost A reply retains B receipt until A retry bridges the exact chain (watch=${observe})`, async () => {
    let lose = true;
    const requests: CommandInput<'saveFile'>[] = [];
    const f = await fixture((raw) => ({
      watch: observe ? raw.watch : () => async () => {},
      async command(name, input, options) {
        const result = await raw.command(name, input, options);
        if (name === 'saveFile') {
          const request = structuredClone(input as CommandInput<'saveFile'>);
          requests.push(request);
          if (request.target.path === 'a.ts' && lose) {
            lose = false;
            throw Error('Lost committed A reply');
          }
        }
        return result;
      },
    }));
    try {
      await assert.rejects(f.editor.save(target('a.ts')), /Lost committed/);
      const a = f.editor.buffer(target('a.ts'))!.pendingSave!;
      f.editor.edit(target('a.ts'), 'newer A');
      await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
      const b = f.editor.buffer(target('b.ts'))!.pendingSave;
      assert(b, 'the known B receipt must retain its immutable request across a gap');
      f.editor.edit(target('b.ts'), 'newer B');
      await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.prepareQuit(),
          async () => 'discard',
        ),
        false,
      );
      assert.equal(await f.editor.save(target('a.ts')), false);
      assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
      assert.equal(f.editor.buffer(target('b.ts'))!.pendingSave, undefined);
      assert.equal(f.memory.stats.saves, 2);
      assert.deepEqual(
        requests.filter((r) => r.target.path === 'a.ts'),
        [a, a],
      );
      assert.equal(requests.filter((r) => r.target.path === 'b.ts').length, 1);
      await f.editor.flush();
      const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      for (const [path, text] of [
        ['a.ts', 'newer A'],
        ['b.ts', 'newer B'],
      ]) {
        assert.equal(stored.state.drafts.find((d) => d.target.path === path)?.text, text);
        assert.equal((await f.raw.command('readFile', target(path))).text, 'captured ' + path);
      }
      const restored = await f.restart();
      for (const [path, text] of [
        ['a.ts', 'newer A'],
        ['b.ts', 'newer B'],
      ]) {
        assert.equal(restored.buffer(target(path))!.text, text);
        assert.equal(restored.buffer(target(path))!.disk.text, 'captured ' + path);
      }
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'cancel',
        ),
        false,
      );
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      await f.dispose();
    }
  });
for (const observe of [false, true])
  test(`reversed three Save replies reconcile retained receipts without repeating writes (watch=${observe})`, async () => {
    const admitted = [gate(), gate()],
      reply = [gate(), gate()];
    const f = await fixture((raw) => ({
      watch: observe ? raw.watch : () => async () => {},
      async command(name, input, options) {
        const result = await raw.command(name, input, options);
        if (name === 'saveFile') {
          const index = ['a.ts', 'b.ts'].indexOf((input as CommandInput<'saveFile'>).target.path);
          if (index >= 0) {
            admitted[index].release();
            await reply[index].promise;
          }
        }
        return result;
      },
    }));
    try {
      const a = f.editor.save(target('a.ts'));
      await admitted[0].promise;
      const b = f.editor.save(target('b.ts'));
      const rejectedB = assert.rejects(b, /revision gap/);
      await admitted[1].promise;
      await assert.rejects(f.editor.save(target('c.ts')), /revision gap/);
      for (const path of ['a.ts', 'b.ts', 'c.ts']) f.editor.edit(target(path), 'newer ' + path);
      reply[1].release();
      await rejectedB;
      reply[0].release();
      assert.equal(await a, false);
      assert.equal(f.memory.stats.saves, 3);
      for (const path of ['a.ts', 'b.ts', 'c.ts'])
        assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
      await f.editor.flush();
      const restored = await f.restart();
      for (const path of ['a.ts', 'b.ts', 'c.ts']) {
        assert.equal(restored.buffer(target(path))!.text, 'newer ' + path);
        assert.equal(restored.buffer(target(path))!.disk.text, 'captured ' + path);
      }
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      reply.forEach((g) => g.release());
      await f.dispose();
    }
  });
for (const committed of [false, true])
  test(`reconciliation publication uncertainty retains all known requests until its exact receipt (committed=${committed})`, async () => {
    let loseA = true,
      fault = false,
      unavailable = false;
    const f = await fixture((raw) => ({
      ...raw,
      async command(name, input, options) {
        if (fault && name === 'persistRecovery') {
          fault = false;
          unavailable = true;
          if (committed) await raw.command(name, input, options);
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Publication response unavailable',
          });
        }
        if (unavailable && name === 'getRecoveryPublication')
          throw Error('Exact lookup unavailable');
        const result = await raw.command(name, input, options);
        if (
          loseA &&
          name === 'saveFile' &&
          (input as CommandInput<'saveFile'>).target.path === 'a.ts'
        ) {
          loseA = false;
          throw Error('Lost A');
        }
        return result;
      },
    }));
    try {
      await assert.rejects(f.editor.save(target('a.ts')), /Lost A/);
      await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
      f.editor.edit(target('a.ts'), 'before pending A');
      f.editor.edit(target('b.ts'), 'before pending B');
      fault = true;
      await assert.rejects(f.editor.save(target('a.ts')), /Publication response/);
      const publication = f.editor.getSnapshot().publication!;
      assert(publication);
      for (const path of ['a.ts', 'b.ts']) assert(f.editor.buffer(target(path))!.pendingSave);
      f.editor.edit(target('a.ts'), 'after pending A');
      f.editor.edit(target('b.ts'), 'after pending B');
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.prepareQuit(),
          async () => 'discard',
        ),
        false,
      );
      unavailable = false;
      assert.equal(await f.editor.resolveRecoveryPublication(), true);
      for (const path of ['a.ts', 'b.ts'])
        assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
      assert(
        await f.raw.command('getRecoveryPublication', {
          clientId: f.editor.clientId,
          requestId: publication.requestId,
        }),
      );
      await f.editor.flush();
      assert.equal(f.memory.stats.saves, 2);
      const restored = await f.restart();
      assert.equal(restored.buffer(target('a.ts'))!.text, 'after pending A');
      assert.equal(restored.buffer(target('b.ts'))!.text, 'after pending B');
      for (const path of ['a.ts', 'b.ts'])
        assert.equal(restored.buffer(target(path))!.disk.text, 'captured ' + path);
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      await f.dispose();
    }
  });
test('a real unrelated same-client publication cannot be bridged by retained own Save receipts', async () => {
  let loseA = true;
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      const result = await raw.command(name, input, options);
      if (
        loseA &&
        name === 'saveFile' &&
        (input as CommandInput<'saveFile'>).target.path === 'a.ts'
      ) {
        loseA = false;
        throw Error('Lost A');
      }
      return result;
    },
  }));
  try {
    await assert.rejects(f.editor.save(target('a.ts')), /Lost A/);
    const before = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
    await f.raw.command('persistRecovery', {
      clientId: f.editor.clientId,
      requestId: 'unrelated',
      expectedRevision: before.revision,
      state: { ...before.state, sidebarWidth: 333 },
    });
    await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
    await assert.rejects(f.editor.save(target('a.ts')), /revision gap/);
    for (const path of ['a.ts', 'b.ts']) {
      f.editor.edit(target(path), 'newer ' + path);
      assert(f.editor.buffer(target(path))!.pendingSave);
    }
    await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
    await assert.rejects(f.editor.flush(), (e) => ApplicationError.is(e) && e.code === 'Conflict');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.prepareQuit(),
        async () => 'discard',
      ),
      false,
    );
    assert.equal(f.memory.stats.saves, 2);
    const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
    assert.equal(stored.state.sidebarWidth, 333);
    assert.equal(stored.revision, before.revision + 2);
    for (const path of ['a.ts', 'b.ts'])
      assert.equal(f.editor.buffer(target(path))!.text, 'newer ' + path);
  } finally {
    await f.dispose();
  }
});
for (const outcome of ['cancel', 'conflict'] as const)
  test(`exact Save chain clears the gate but a later captured-close ${outcome} retains completed Saves and proposed drafts`, async () => {
    let lose = true;
    const f = await fixture((raw) => ({
      ...raw,
      async command(name, input, options) {
        const result = await raw.command(name, input, options);
        if (lose && name === 'saveFile') {
          lose = false;
          throw Error('Lost A');
        }
        return result;
      },
    }));
    try {
      await assert.rejects(f.editor.save(target('a.ts')), /Lost A/);
      await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
      assert.equal(await f.editor.save(target('a.ts')), true);
      assert.equal(f.memory.stats.saves, 2);
      for (const path of ['a.ts', 'b.ts']) f.editor.edit(target(path), 'later ' + path);
      await f.editor.flush();
      if (outcome === 'conflict') f.memory.externalWrite(target('b.ts'), 'external B');
      const choices =
        outcome === 'cancel'
          ? (['save', 'discard', 'cancel'] as const)
          : (['save', 'save'] as const);
      let index = 0;
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.close([target('a.ts'), target('b.ts'), target('c.ts')]),
          async () => choices[index++],
        ),
        false,
      );
      assert.equal(f.memory.stats.saves, 3);
      assert.equal((await f.raw.command('readFile', target('a.ts'))).text, 'later a.ts');
      assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'later a.ts');
      assert.equal(f.editor.buffer(target('b.ts'))!.text, 'later b.ts');
      const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(stored.state.drafts.find((d) => d.target.path === 'b.ts')?.text, 'later b.ts');
      assert.equal(
        stored.state.drafts.find((d) => d.target.path === 'c.ts')?.text,
        'captured c.ts',
      );
      const restored = await f.restart();
      assert.equal(restored.buffer(target('b.ts'))!.text, 'later b.ts');
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      await f.dispose();
    }
  });
test('disposal releases observations and prevents a late missing Save receipt from publishing', async () => {
  const admitted = gate(),
    reply = gate();
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      const result = await raw.command(name, input, options);
      if (name === 'saveFile' && (input as CommandInput<'saveFile'>).target.path === 'a.ts') {
        admitted.release();
        await reply.promise;
      }
      return result;
    },
  }));
  try {
    const saving = f.editor.save(target('a.ts'));
    const cancelled = assert.rejects(
      saving,
      (error) => ApplicationError.is(error) && error.code === 'Cancelled',
    );
    await admitted.promise;
    await assert.rejects(f.editor.save(target('b.ts')), /revision gap/);
    const publications = f.memory.stats.publications;
    await f.editor.dispose();
    reply.release();
    await cancelled;
    assert.equal(f.memory.stats.publications, publications);
    assert.equal(f.memory.stats.saves, 2);
    await f.runtime.dispose();
    assert.equal(f.memory.stats.active, 0);
  } finally {
    reply.release();
    await f.dispose();
  }
});

for (const committed of [false, true])
  for (const observe of [false, true])
    test(`an in-flight B Save cannot strand A's uncertain publication (committed=${committed}, watch=${observe})`, async () => {
      const entered = gate(),
        release = gate();
      let holdB = false,
        noStatus = false,
        rejectRetry = false;
      const saves: CommandInput<'saveFile'>[] = [],
        publications: CommandInput<'persistRecovery'>[] = [];
      const f = await fixture((raw) => ({
        watch: observe ? raw.watch : () => async () => {},
        async command(name, input, options) {
          if (name === 'saveFile') {
            const request = input as CommandInput<'saveFile'>;
            saves.push(structuredClone(request));
            if (holdB && request.target.path === 'b.ts') {
              entered.release();
              await release.promise;
            }
          }
          if (name === 'persistRecovery') {
            publications.push(structuredClone(input as CommandInput<'persistRecovery'>));
            if (rejectRetry) {
              rejectRetry = false;
              throw new ApplicationError({
                code: 'Unavailable',
                message: 'Original retry delivery unavailable',
              });
            }
          }
          if (noStatus && name === 'getRecoveryPublication')
            throw new ApplicationError({
              code: 'Unavailable',
              message: 'Exact status unavailable',
            });
          return raw.command(name, input, options);
        },
      }));
      try {
        holdB = true;
        const b = f.editor.save(target('b.ts'));
        await entered.promise;
        noStatus = true;
        f.memory.failNext('persistRecovery', 'Unknown A publication', committed);
        await assert.rejects(f.editor.save(target('a.ts')), /Unknown A publication/);
        const pending = f.editor.getSnapshot().publication!;
        assert(pending);
        const original = publications.find((p) => p.requestId === pending.requestId)!;
        release.release();
        await b;
        const ids = ['a.ts', 'b.ts'].map(
          (path) => f.editor.buffer(target(path))!.pendingSave!.requestId,
        );
        f.editor.edit(target('a.ts'), 'NEWER A');
        f.editor.edit(target('b.ts'), 'NEWER B');
        assert.equal(await f.editor.resolveRecoveryPublication(), false);
        assert.equal(f.editor.getSnapshot().publication!.requestId, pending.requestId);
        noStatus = false;
        if (!committed) {
          rejectRetry = true;
          assert.equal(await f.editor.resolveRecoveryPublication(), false);
          assert.equal(f.editor.getSnapshot().publication!.requestId, pending.requestId);
        }
        assert.equal(
          await f.editor.resolveRecoveryPublication(),
          true,
          'an exact receipt or definitive identical-retry rejection must release the metadata gate',
        );
        await f.editor.reconcileRecovery();
        await f.editor.flush();
        assert.equal(f.editor.getSnapshot().publication, undefined);
        for (const path of ['a.ts', 'b.ts'])
          assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
        for (const retry of publications.filter((p) => p.requestId === pending.requestId))
          assert.deepEqual(retry, original);
        assert.equal(saves.length, 2);
        assert.deepEqual(new Set(saves.map((r) => r.requestId)), new Set(ids));
        assert.equal(f.memory.stats.saves, 2);
        assert.equal(
          !!(await f.raw.command('getRecoveryPublication', {
            clientId: f.editor.clientId,
            requestId: pending.requestId,
          })),
          committed,
        );
        const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
        for (const [path, text] of [
          ['a.ts', 'NEWER A'],
          ['b.ts', 'NEWER B'],
        ]) {
          assert.equal(stored.state.drafts.find((d) => d.target.path === path)?.text, text);
          assert.equal((await f.raw.command('readFile', target(path))).text, 'captured ' + path);
        }
        const restored = await f.restart();
        for (const [path, text] of [
          ['a.ts', 'NEWER A'],
          ['b.ts', 'NEWER B'],
        ]) {
          assert.equal(restored.buffer(target(path))!.text, text);
          assert.equal(restored.buffer(target(path))!.disk.text, 'captured ' + path);
        }
        assert.equal(
          await answering(
            restored,
            () => restored.prepareQuit(),
            async () => 'cancel',
          ),
          false,
        );
        assert.equal(
          await answering(
            restored,
            () => restored.prepareQuit(),
            async () => 'discard',
          ),
          true,
        );
      } finally {
        release.release();
        await f.dispose();
      }
    });

test('retiring a rejected publication cannot bridge an unrelated same-client CAS gap', async () => {
  const entered = gate(),
    release = gate();
  let holdB = false;
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      if (
        name === 'saveFile' &&
        holdB &&
        (input as CommandInput<'saveFile'>).target.path === 'b.ts'
      ) {
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  }));
  try {
    holdB = true;
    const b = f.editor.save(target('b.ts'));
    await entered.promise;
    f.memory.failNext('persistRecovery');
    await assert.rejects(f.editor.save(target('a.ts')));
    const publication = f.editor.getSnapshot().publication!;
    const loaded = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
    await f.raw.command('persistRecovery', {
      clientId: f.editor.clientId,
      requestId: 'competing-publication',
      expectedRevision: loaded.revision,
      state: { ...loaded.state, sidebarWidth: 333 },
    });
    release.release();
    await b;
    f.editor.edit(target('a.ts'), 'NEWER A');
    f.editor.edit(target('b.ts'), 'NEWER B');
    assert.equal(await f.editor.resolveRecoveryPublication(), false);
    assert.equal(f.editor.getSnapshot().publication, undefined);
    assert.equal(
      await f.raw.command('getRecoveryPublication', {
        clientId: f.editor.clientId,
        requestId: publication.requestId,
      }),
      null,
    );
    for (const path of ['a.ts', 'b.ts']) assert(f.editor.buffer(target(path))!.pendingSave);
    await assert.rejects(f.editor.reconcileRecovery(), /revision gap/);
    await assert.rejects(f.editor.flush(), (e) => ApplicationError.is(e) && e.code === 'Conflict');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.prepareQuit(),
        async () => 'discard',
      ),
      false,
    );
    assert.equal(f.memory.stats.saves, 2);
    assert.equal(
      (await f.raw.command('loadRecovery', { clientId: f.editor.clientId })).state.sidebarWidth,
      333,
    );
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'NEWER A');
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'NEWER B');
  } finally {
    release.release();
    await f.dispose();
  }
});
for (const kind of ['close', 'reload'] as const)
  test(`a definitively rejected final ${kind} releases preservation without executing its old destructive callback`, async () => {
    let rejectFinal = true;
    const f = await fixture((raw) => ({
      ...raw,
      async command(name, input, options) {
        if (
          name === 'persistRecovery' &&
          rejectFinal &&
          !(input as CommandInput<'persistRecovery'>).state.drafts.some(
            (d) => d.target.path === 'a.ts',
          )
        ) {
          rejectFinal = false;
          throw new ApplicationError({
            code: 'Persistence',
            message: 'Final delivery failed before commit',
          });
        }
        return raw.command(name, input, options);
      },
    }));
    try {
      if (kind === 'reload') f.memory.externalWrite(target('a.ts'), 'external A');
      if (kind === 'close')
        assert.equal(
          await answering(
            f.editor,
            () => f.editor.close([target('a.ts')]),
            async () => 'discard',
          ),
          false,
        );
      else await assert.rejects(f.editor.reload(target('a.ts')), /Final delivery/);
      const pending = f.editor.getSnapshot().publication!;
      assert.equal(pending.kind, kind);
      assert.equal(f.editor.getSnapshot().preserving, true);
      const sources = await f.raw.command('inspectEntries', { checkout, paths: ['b.ts'] });
      await f.raw.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: 'move-after-final-failure',
        kind: 'move',
        sources,
        destination: 'moved.ts',
      });
      assert.equal(
        await f.editor.resolveRecoveryPublication(),
        false,
        'the original destructive action did not commit',
      );
      assert.equal(f.editor.getSnapshot().publication, undefined);
      assert.equal(f.editor.getSnapshot().preserving, false);
      assert.equal(
        await f.raw.command('getRecoveryPublication', {
          clientId: f.editor.clientId,
          requestId: pending.requestId,
        }),
        null,
      );
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'captured a.ts');
      assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'A');
      assert(f.editor.getSnapshot().recovery.views[checkout.checkoutId].openFiles.includes('a.ts'));
      assert.equal(f.editor.buffer(target('moved.ts'))!.text, 'captured b.ts');
      const stored = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(
        stored.state.drafts.find((d) => d.target.path === 'a.ts')!.text,
        'captured a.ts',
      );
      const restored = await f.restart();
      assert.equal(restored.buffer(target('a.ts'))!.text, 'captured a.ts');
      let choices = 0;
      assert.equal(
        await answering(
          restored,
          () => restored.close([target('a.ts')]),
          async () => {
            choices++;
            return 'cancel';
          },
        ),
        false,
      );
      assert.equal(choices, 1);
      if (kind === 'close') {
        assert.equal(
          await answering(
            restored,
            () => restored.close([target('a.ts')]),
            async () => 'discard',
          ),
          true,
        );
        assert.equal(restored.buffer(target('a.ts')), undefined);
      } else {
        assert.equal(await restored.reload(target('a.ts')), true);
        assert.equal(restored.buffer(target('a.ts'))!.text, 'external A');
      }
      assert.equal(f.memory.stats.saves, 0);
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      await f.dispose();
    }
  });
test('a status-query Conflict does not prove publication rejection', async () => {
  let queryFails = true;
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      if (queryFails && name === 'getRecoveryPublication')
        throw new ApplicationError({ code: 'Conflict', message: 'Query failed' });
      return raw.command(name, input, options);
    },
  }));
  try {
    f.memory.failNext('persistRecovery');
    await assert.rejects(f.editor.save(target('a.ts')));
    const pending = f.editor.getSnapshot().publication!;
    assert.equal(await f.editor.resolveRecoveryPublication(), false);
    assert.equal(f.editor.getSnapshot().publication!.requestId, pending.requestId);
    assert(f.editor.buffer(target('a.ts'))!.pendingSave);
    queryFails = false;
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
    assert.equal(f.memory.stats.saves, 1);
  } finally {
    await f.dispose();
  }
});
test("a committed publication clears only its captured A identity when B's later publication is uncertain", async () => {
  const entered = gate(),
    release = gate();
  let holdB = false,
    statusFails = true;
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      if (
        name === 'saveFile' &&
        holdB &&
        (input as CommandInput<'saveFile'>).target.path === 'b.ts'
      ) {
        entered.release();
        await release.promise;
      }
      if (name === 'getRecoveryPublication' && statusFails) throw Error('Status unavailable');
      return raw.command(name, input, options);
    },
  }));
  try {
    holdB = true;
    const b = f.editor.save(target('b.ts'));
    await entered.promise;
    f.memory.failNext('persistRecovery', 'Lost committed A publication', true);
    await assert.rejects(f.editor.save(target('a.ts')));
    const aPublication = f.editor.getSnapshot().publication!;
    release.release();
    await b;
    statusFails = false;
    f.memory.failNext('persistRecovery', 'B publication not delivered');
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    await f.editor.reconcileRecovery().catch(() => {});
    assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
    assert(f.editor.buffer(target('b.ts'))!.pendingSave);
    const bPublication = f.editor.getSnapshot().publication!;
    assert(bPublication);
    assert.notEqual(bPublication.requestId, aPublication.requestId);
    f.editor.edit(target('b.ts'), 'B after its pending publication');
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    await f.editor.flush();
    const restored = await f.restart();
    assert.equal(restored.buffer(target('b.ts'))!.text, 'B after its pending publication');
    assert.equal(restored.buffer(target('b.ts'))!.disk.text, 'captured b.ts');
    assert.equal(f.memory.stats.saves, 2);
  } finally {
    release.release();
    await f.dispose();
  }
});
test('disposal during publication uncertainty cancels a later B admission without publishing or replay', async () => {
  const entered = gate(),
    release = gate();
  let holdB = false;
  const f = await fixture((raw) => ({
    ...raw,
    async command(name, input, options) {
      if (
        name === 'saveFile' &&
        holdB &&
        (input as CommandInput<'saveFile'>).target.path === 'b.ts'
      ) {
        entered.release();
        await release.promise;
      }
      return raw.command(name, input, options);
    },
  }));
  try {
    holdB = true;
    const b = f.editor.save(target('b.ts'));
    const cancelled = assert.rejects(b, (e) => ApplicationError.is(e) && e.code === 'Cancelled');
    await entered.promise;
    f.memory.failNext('persistRecovery');
    await assert.rejects(f.editor.save(target('a.ts')));
    const publications = f.memory.stats.publications;
    await f.editor.dispose();
    release.release();
    await cancelled;
    assert.equal(await f.editor.resolveRecoveryPublication(), false);
    assert.equal(f.memory.stats.publications, publications);
    assert.equal(f.memory.stats.saves, 1);
    assert.equal((await f.raw.command('readFile', target('b.ts'))).text, 'B');
  } finally {
    release.release();
    await f.dispose();
  }
});

describe('controller Save receipts', () => {
  const { checkout, target, fixture } = controllerFixture;
  test('Save receipts advance only known own revisions; a competing same-client publication gap stays visible', async () => {
    const f = await fixture('unused', false);
    await f.editor.dispose();
    let ready!: () => void, release!: () => void;
    const admitted = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const client: EditorClient = {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'saveFile') {
          const { clientId } = input as CommandInput<'saveFile'>;
          const loaded = await f.client.command('loadRecovery', { clientId });
          await f.client.command('persistRecovery', {
            requestId: crypto.randomUUID(),
            clientId,
            expectedRevision: loaded.revision,
            state: { ...loaded.state, sidebarWidth: 333 },
          });
          const result = await f.client.command(name, input, options);
          ready();
          await wait;
          return result;
        }
        return f.client.command(name, input, options);
      },
    };
    const editor = await acquireEditor(f.runtime, { client, clientId: 'receipt-gap' });
    try {
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'captured');
      await editor.flush();
      const save = editor.save(target('a.ts'));
      const rejection = assert.rejects(save, /revision gap/);
      await admitted;
      editor.edit(target('a.ts'), 'newer live text');
      release();
      await rejection;
      assert.equal(editor.buffer(target('a.ts'))!.text, 'newer live text');
      assert.equal(editor.buffer(target('a.ts'))!.disk.text, 'captured');
      assert.equal(
        await answering(
          editor,
          () => editor.close([target('a.ts')]),
          async () => 'discard',
        ),
        false,
      );
      assert.equal(f.memory.stats.saves, 1);
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: editor.clientId })).state.sidebarWidth,
        333,
      );
    } finally {
      release();
      await editor.dispose();
      await f.dispose();
    }
  });

  test('definitive InvalidInput Save frees the captured request while uncertain retries remain immutable', async () => {
    const f = await fixture('invalid-save', false);
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'bad\0text');
      await assert.rejects(
        f.editor.save(target('a.ts')),
        (error) => ApplicationError.is(error) && error.code === 'InvalidInput',
      );
      assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
      assert.equal(f.memory.stats.saves, 0);
      f.editor.edit(target('a.ts'), 'corrected');
      assert.equal(await f.editor.save(target('a.ts')), true);
      f.editor.edit(target('a.ts'), 'another\0invalid');
      await assert.rejects(f.editor.save(target('a.ts')));
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.prepareQuit(),
          async () => 'discard',
        ),
        false,
      );
      f.editor.edit(target('a.ts'), 'corrected before preservation');
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      await f.dispose();
    }
  });
});
