import { acquireEditor, answering } from './editor-model-fixture.ts';
import { held, storedRecovery } from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type EditorClient,
} from '@moonbase/contracts/workspace';
import { type EditorController } from '@moonbase/application/editor';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const checkout: CheckoutTarget = {
  hostId: 'saves',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/save-fixture',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const target = (path: string) => ({ checkout, path });
/** An editor with drafts in a.ts, b.ts and c.ts, through a client the test may wrap. */
async function fixture(wrap: (raw: EditorClient) => EditorClient = (raw) => raw) {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' } }]);
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
    stored: () => storedRecovery(raw, editor.clientId),
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
/** Saves of `path` whose reply is lost once after the file is written. */
const losingReply =
  (path: string, requests: CommandInput<'saveFile'>[] = []) =>
  (raw: EditorClient): EditorClient => {
    let lose = true;
    return {
      ...raw,
      async command(name, input, options) {
        const result = await raw.command(name, input, options);
        if (name === 'saveFile') {
          const request = structuredClone(input as CommandInput<'saveFile'>);
          requests.push(request);
          if (lose && request.target.path === path) {
            lose = false;
            throw new ApplicationError({ code: 'Uncertain', message: 'Lost committed reply' });
          }
        }
        return result;
      },
    };
  };
const quit = (editor: EditorController, choice: 'discard' | 'cancel') =>
  answering(
    editor,
    () => editor.prepareQuit(),
    async () => choice,
  );

test('a lost Save reply keeps its request for the retry, and drafts typed since survive restart', async () => {
  const requests: CommandInput<'saveFile'>[] = [];
  const f = await fixture(losingReply('a.ts', requests));
  try {
    await assert.rejects(f.editor.save(target('a.ts')), /Lost committed/);
    const a = structuredClone(f.editor.buffer(target('a.ts'))!.pendingSave!);
    f.editor.edit(target('a.ts'), 'newer A');
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(await quit(f.editor, 'discard'), false, 'an unresolved Save blocks quitting');
    assert.equal(await f.editor.save(target('b.ts')), true);
    f.editor.edit(target('b.ts'), 'newer B');
    assert.equal(await f.editor.save(target('a.ts')), false, 'A stays dirty with its newer text');
    assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
    assert.deepEqual(
      requests.filter((r) => r.target.path === 'a.ts'),
      [a, a],
    );
    assert.equal(f.memory.stats.saves, 2);
    await f.editor.flush();
    const { drafts } = await f.stored();
    for (const [path, text] of [
      ['a.ts', 'newer A'],
      ['b.ts', 'newer B'],
    ]) {
      const draft = drafts.find((d) => d.target.path === path)!;
      assert.equal(draft.text, text);
      assert.equal(draft.disk.text, 'captured ' + path);
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
    assert.equal(await quit(restored, 'cancel'), false);
    assert.equal(await quit(restored, 'discard'), true);
  } finally {
    await f.dispose();
  }
});

test('Save replies arriving in reverse order keep every newer draft without repeating writes', async () => {
  const admitted = [held(), held()],
    reply = [held(), held()];
  const f = await fixture((raw) => ({
    ...raw,
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
    await admitted[1].promise;
    assert.equal(await f.editor.save(target('c.ts')), true);
    for (const path of ['a.ts', 'b.ts', 'c.ts']) f.editor.edit(target(path), 'newer ' + path);
    reply[1].release();
    assert.equal(await b, false);
    reply[0].release();
    assert.equal(await a, false);
    assert.equal(f.memory.stats.saves, 3);
    for (const path of ['a.ts', 'b.ts', 'c.ts'])
      assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const restored = await f.restart();
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      assert.equal(restored.buffer(target(path))!.text, 'newer ' + path);
      assert.equal(restored.buffer(target(path))!.disk.text, 'captured ' + path);
    }
    assert.equal(await quit(restored, 'discard'), true);
  } finally {
    reply.forEach((g) => g.release());
    await f.dispose();
  }
});

for (const outcome of ['cancel', 'conflict'] as const)
  test(`a close after a retried lost Save keeps completed saves and drafts when it ends in ${outcome}`, async () => {
    const f = await fixture(losingReply('a.ts'));
    try {
      await assert.rejects(f.editor.save(target('a.ts')), /Lost committed/);
      assert.equal(await f.editor.save(target('b.ts')), true);
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
      const { drafts } = await f.stored();
      assert.equal(drafts.find((d) => d.target.path === 'b.ts')?.text, 'later b.ts');
      assert.equal(drafts.find((d) => d.target.path === 'c.ts')?.text, 'captured c.ts');
      const restored = await f.restart();
      assert.equal(restored.buffer(target('b.ts'))!.text, 'later b.ts');
      assert.equal(await quit(restored, 'discard'), true);
    } finally {
      await f.dispose();
    }
  });

for (const kind of ['close', 'reload'] as const)
  test(`a failed discard on ${kind} keeps the draft in the editor and the store`, async () => {
    const f = await fixture();
    try {
      if (kind === 'reload') f.memory.externalWrite(target('a.ts'), 'external A');
      f.memory.failNext('closeTab', 'Discard not delivered');
      if (kind === 'close')
        assert.equal(
          await answering(
            f.editor,
            () => f.editor.close([target('a.ts')]),
            async () => 'discard',
          ),
          false,
        );
      else await assert.rejects(f.editor.reload(target('a.ts')), /Discard not delivered/);
      assert.equal(f.editor.getSnapshot().preserving, false);
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'captured a.ts');
      assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'A');
      assert(f.editor.getSnapshot().recovery.views[checkout.checkoutId].openFiles.includes('a.ts'));
      // The failed discard is withdrawn, not delivered by the next flush behind the editor's back.
      await f.editor.flush();
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'captured a.ts');
      const stored = await f.stored();
      assert.equal(stored.drafts.find((d) => d.target.path === 'a.ts')?.text, 'captured a.ts');
      assert.deepEqual(stored.tabs(checkout.checkoutId), ['a.ts', 'b.ts', 'c.ts']);
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
    } finally {
      await f.dispose();
    }
  });

test('disposal during a held Save cancels it, releases observations and sends no edits', async () => {
  const admitted = held(),
    reply = held();
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
    const cancelled = assert.rejects(
      f.editor.save(target('a.ts')),
      (error) => ApplicationError.is(error) && error.code === 'Cancelled',
    );
    await admitted.promise;
    const edits = f.memory.stats.edits;
    await f.editor.dispose();
    reply.release();
    await cancelled;
    assert.equal(f.memory.stats.edits, edits);
    assert.equal(f.memory.stats.saves, 1);
    await f.runtime.dispose();
    assert.equal(f.memory.stats.active, 0);
  } finally {
    reply.release();
    await f.dispose();
  }
});

test('a Save refused as invalid frees its request, and a corrected Save goes through', async () => {
  const f = await fixture();
  try {
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
    assert.equal(f.editor.buffer(target('a.ts'))!.pendingSave, undefined);
    assert.equal(await quit(f.editor, 'discard'), false, 'recovery cannot keep the invalid text');
    f.editor.edit(target('a.ts'), 'corrected before preservation');
    assert.equal(await quit(f.editor, 'discard'), true);
  } finally {
    await f.dispose();
  }
});
