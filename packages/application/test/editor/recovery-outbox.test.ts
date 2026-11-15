import { acquireEditor } from './editor-model-fixture.ts';
import { holding, storedRecovery } from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'ready',
  projectId: 'project',
  root: '/memory/ready',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const target = { checkout, path: 'a.ts' };
const other = { checkout, path: 'b.ts' };

/** An editor whose commands the test can hold, with a.ts open. */
async function fixture() {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'disk', 'b.ts': 'other' } }]),
    runtime = ManagedRuntime.make(memory.layer),
    raw = makeEditorClient(runtime);
  const { client, sent, hold } = holding(raw);
  const editor = await acquireEditor(runtime, { client, clientId: 'outbox' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.open(target, { intent: 'keep' });
  await editor.flush();
  return {
    memory,
    raw,
    editor,
    sent,
    hold,
    stored: () => storedRecovery(raw, 'outbox'),
    async restart() {
      await editor.dispose();
      const next = await acquireEditor(runtime, { client: raw, clientId: 'outbox' });
      await next.load();
      return next;
    },
    async dispose() {
      await editor.dispose();
      await runtime.dispose();
    },
  };
}
const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  void promise.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  return state;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a change makes recovery unready at once until its edit commits, and survives a restart', async () => {
  const f = await fixture();
  try {
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.edit(target, 'fresh visible tail');
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.edit(target, 'disk');
    f.editor.edit(target, 'fresh visible tail');
    assert.equal(f.editor.getSnapshot().recoveryReady, false, 'equal text is still a change');
    await f.editor.flush();
    const next = await f.restart();
    assert.equal(next.buffer(target)!.text, 'fresh visible tail');
    assert.equal(next.buffer(target)!.disk.text, 'disk');
    await next.dispose();
  } finally {
    await f.dispose();
  }
});

test('edits are sent one at a time in order, and flush resolves only once they commit', async () => {
  const f = await fixture();
  const hold = f.hold('edit');
  try {
    f.editor.edit(target, 'first');
    const flushing = f.editor.flush(),
      flushed = settled(flushing);
    await hold.entered;
    const before = f.sent.length;
    await f.editor.open(other, { intent: 'keep' });
    f.editor.edit(other, 'second');
    f.editor.edit(target, 'third');
    const later = settled(f.editor.flush());
    await tick();
    assert.equal(f.sent.length, before, 'nothing is sent while the held edit is in flight');
    assert.equal(flushed.done, false);
    assert.equal(later.done, false);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.deepEqual((await f.stored()).drafts, [], 'the held edit has not committed');
    hold.release();
    await flushing;
    await f.editor.flush();
    assert.equal(later.done, true);
    assert.deepEqual(
      f.sent.slice(before - 1).map(({ name, input }) => {
        const edit = input as { bufferId?: string; text?: string };
        return edit.text ?? name;
      }),
      ['first', 'openTab', 'second', 'third', 'updateLayout'],
    );
    const stored = await f.stored();
    assert.deepEqual(
      stored.drafts.map((d) => [d.target.path, d.text]),
      [
        ['a.ts', 'third'],
        ['b.ts', 'second'],
      ],
    );
    assert.deepEqual(stored.tabs(checkout.checkoutId), ['a.ts', 'b.ts']);
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally {
    hold.release();
    await f.dispose();
  }
});

test("a buffer's newer text replaces its unsent text", async () => {
  const f = await fixture();
  try {
    const edits = f.memory.stats.edits;
    f.editor.edit(target, 'one');
    f.editor.edit(target, 'two');
    f.editor.edit(target, 'three');
    await f.editor.flush();
    assert.equal(f.memory.stats.edits - edits, 1);
    assert.equal((await f.stored()).drafts[0].text, 'three');
  } finally {
    await f.dispose();
  }
});

test('a failed edit keeps recovery failed and unready until it goes again and commits', async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, 'kept after failure');
    f.memory.failNext('updateDraft', 'Store unavailable');
    await assert.rejects(f.editor.flush(), /Store unavailable/);
    assert.equal(f.editor.getSnapshot().recoveryFailed, true);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.deepEqual((await f.stored()).drafts, []);
    f.editor.edit(target, 'newer after failure');
    assert.equal(f.editor.getSnapshot().recoveryFailed, true);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryFailed, false);
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    assert.equal((await f.stored()).drafts[0].text, 'newer after failure');
    // Without a change or a flush, a failed edit goes again on its own.
    f.memory.failNext('updateDraft', 'Store unavailable');
    f.editor.edit(target, 'kept by the retry');
    await assert.rejects(f.editor.flush(), /Store unavailable/);
    for (let turn = 0; !f.editor.getSnapshot().recoveryReady; turn++) {
      assert(turn < 300, 'the failed edit was not sent again');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.editor.getSnapshot().recoveryFailed, false);
    assert.equal((await f.stored()).drafts[0].text, 'kept by the retry');
  } finally {
    await f.dispose();
  }
});

test('an edit made during a held save is kept over the saved text', async () => {
  const f = await fixture();
  const hold = f.hold('saveFile');
  try {
    f.editor.edit(target, 'saved');
    const saving = f.editor.save(target);
    await hold.entered;
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    f.editor.edit(target, 'typed while saving');
    hold.release();
    assert.equal(await saving, false, 'the buffer is still dirty');
    await f.editor.flush();
    assert.equal((await f.raw.command('readFile', target)).text, 'saved');
    const { drafts } = await f.stored();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].text, 'typed while saving');
    assert.equal(drafts[0].disk.text, 'saved');
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const next = await f.restart();
    assert.equal(next.buffer(target)!.text, 'typed while saving');
    assert.equal(next.buffer(target)!.disk.text, 'saved');
    await next.dispose();
  } finally {
    hold.release();
    await f.dispose();
  }
});

test('read-only work and diagnostics leave recovery ready; view changes do not', async () => {
  const f = await fixture();
  const lookup = f.hold('lookupFiles');
  try {
    f.editor.edit(target, 'durable dirty');
    await f.editor.flush();
    f.editor.report(Error('visible diagnostic'));
    await f.editor.list(checkout);
    const looking = f.editor.lookup(checkout, 'a');
    await lookup.entered;
    assert.equal(f.editor.getSnapshot().recoveryReady, true, 'a held lookup does not veto');
    lookup.release();
    await looking;
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.position(target, 'file', { line: 2, column: 3, top: 0, left: 0 });
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    await f.editor.dispose();
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await tick();
    assert.equal(f.memory.stats.active, 0);
  } finally {
    lookup.release();
    await f.dispose();
  }
});

test("a reload's discard and reopen keep the tab's place in the store", async () => {
  const f = await fixture();
  try {
    await f.editor.open(other, { intent: 'keep' });
    f.editor.edit(target, 'discarded by reload');
    await f.editor.flush();
    f.memory.externalWrite(target, 'external');
    assert.equal(await f.editor.reload(target), true);
    await f.editor.flush();
    const stored = await f.stored();
    assert.deepEqual(stored.drafts, []);
    assert.deepEqual(stored.tabs(checkout.checkoutId), ['a.ts', 'b.ts']);
  } finally {
    await f.dispose();
  }
});
