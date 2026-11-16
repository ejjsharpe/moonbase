import { acquireEditor, answering } from './editor-model-fixture.ts';
import { holding, storedRecovery } from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { toWorkspaceClient as makeEditorClient } from '@moonbase/application/testing/editor-fixture';
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
const third = { checkout, path: 'c.ts' };

/** An editor whose commands the test can hold, with a.ts open; `testClock` runs its debounce. */
async function fixture(testClock = false) {
  const memory = fauxWorkspace([
      { checkout, files: { 'a.ts': 'disk', 'b.ts': 'other', 'c.ts': 'third' } },
    ]),
    runtime = ManagedRuntime.make(
      testClock ? Layer.merge(memory.layer, TestClock.layer()) : memory.layer,
    ),
    raw = makeEditorClient(runtime);
  const { client, sent, hold } = holding(raw);
  const editor = await acquireEditor(runtime, { client, clientId: 'outbox' });
  await editor.load();
  await editor.openCheckout(checkout.root);
  await editor.open(target, { intent: 'keep' });
  await editor.flush();
  return {
    memory,
    runtime,
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

test('a failed edit keeps recovery failed and unready until a later flush succeeds', async () => {
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

test('a failed preview close leaves no stale buffer: reopening its file ends in one open, not a loop', async () => {
  const f = await fixture();
  try {
    await f.editor.open(other, { intent: 'preview' });
    await f.editor.flush();
    // Replacing the preview closes b.ts; that close fails before reaching the store.
    f.memory.failNext('closeTab', 'Store unavailable', false, 'Unavailable');
    await f.editor.open(third, { intent: 'preview' });
    await assert.rejects(f.editor.flush(), /Store unavailable/);
    assert.equal(f.editor.getSnapshot().recoveryFailed, true);
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryFailed, false);
    assert.equal(
      (await f.stored()).state.buffers.filter((b) => b.target.path === 'b.ts').length,
      1,
      'the store still holds the buffer the editor closed',
    );
    // Opened again under a new buffer, the file is refused once; the resync closes the stale
    // buffer and opens the new one.
    const before = f.sent.length;
    await f.editor.open(other, { intent: 'keep' });
    await f.editor.flush();
    assert(f.sent.length - before < 12, 'the open was sent again and again');
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const stored = await f.stored();
    const shown = f.editor.getSnapshot().recovery.views[checkout.checkoutId]!.openFiles;
    assert.deepEqual(stored.tabs(checkout.checkoutId), shown);
    assert.deepEqual([...shown].sort(), ['a.ts', 'b.ts', 'c.ts']);
    assert.equal(stored.state.buffers.filter((b) => b.target.path === 'b.ts').length, 1);
  } finally {
    await f.dispose();
  }
});

test('a refusal that no resync resolves ends in a failed recovery, not a loop', async () => {
  const f = await fixture();
  try {
    // Every open is refused as given.
    for (let turn = 0; turn < 8; turn++)
      f.memory.failNext('openTab', 'Another buffer is already open for this file.');
    await f.editor.open(other, { intent: 'keep' });
    const before = f.sent.length;
    await assert.rejects(f.editor.flush());
    assert(f.sent.length - before < 12);
    assert.equal(f.editor.getSnapshot().recoveryFailed, true);
  } finally {
    await f.dispose();
  }
});

for (const kind of ['close', 'quit', 'reload'] as const)
  test(`a ${kind} Discard whose reply is lost stands once the store shows it committed`, async () => {
    const f = await fixture();
    try {
      f.editor.edit(target, 'discarded');
      await f.editor.flush();
      assert.equal((await f.stored()).drafts[0]?.text, 'discarded');
      // The store commits the close, then its reply is lost.
      f.memory.failNext('closeTab', 'Reply lost', true, 'Uncertain');
      let done: boolean;
      if (kind === 'reload') {
        f.memory.externalWrite(target, 'reloaded');
        done = await f.editor.reload(target);
      } else
        done = await answering(
          f.editor,
          () => (kind === 'close' ? f.editor.close([target]) : f.editor.prepareQuit()),
          async () => 'discard',
        );
      assert.equal(done, true);
      await f.editor.flush();
      const snapshot = f.editor.getSnapshot();
      assert.equal(snapshot.recoveryReady, true);
      const stored = await f.stored();
      assert.deepEqual(stored.drafts, []);
      // What the editor shows is what the store holds.
      if (kind === 'close') {
        assert.equal(f.editor.buffer(target), undefined);
        assert.deepEqual(stored.tabs(checkout.checkoutId), []);
      } else {
        assert.equal(f.editor.buffer(target)?.text, kind === 'reload' ? 'reloaded' : 'disk');
        assert.deepEqual(stored.tabs(checkout.checkoutId), ['a.ts']);
      }
    } finally {
      await f.dispose();
    }
  });

test('a Discard whose reply is lost, and not committed, keeps the draft shown and stored', async () => {
  const f = await fixture(true);
  try {
    f.editor.edit(target, 'kept');
    await f.editor.flush();
    f.memory.failNext('closeTab', 'Store unavailable', false, 'Unavailable');
    const done = await answering(
      f.editor,
      () => f.editor.close([target]),
      async () => 'discard',
    );
    assert.equal(done, false);
    assert.equal(f.editor.buffer(target)?.text, 'kept');
    // The debounce's send after the veto has nothing to send, and leaves the failure shown.
    await f.runtime.runPromise(TestClock.adjust('1 second'));
    for (let turn = 0; turn < 10; turn++) await f.runtime.runPromise(Effect.yieldNow).then(tick);
    assert.equal(f.editor.getSnapshot().recoveryFailed, true);
    assert.equal((await f.stored()).drafts[0]?.text, 'kept');
    // Nothing sends the Discard again: the user's retry leaves the draft where it is.
    await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryFailed, false);
    assert.equal((await f.stored()).drafts[0]?.text, 'kept');
    assert.equal(f.editor.buffer(target)?.text, 'kept');
  } finally {
    await f.dispose();
  }
});

test('a lost Discard reply the store cannot be asked about is settled by the next flush', async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, 'discarded later');
    await f.editor.flush();
    f.memory.failNext('closeTab', 'Reply lost', true, 'Uncertain');
    f.memory.failNext('loadRecovery', 'Store unavailable', false, 'Unavailable');
    const done = await answering(
      f.editor,
      () => f.editor.close([target]),
      async () => 'discard',
    );
    assert.equal(done, false);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    // The store shows the close committed: the Discard stands and the tab closes.
    await f.editor.flush();
    assert.equal(f.editor.buffer(target), undefined);
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const stored = await f.stored();
    assert.deepEqual(stored.drafts, []);
    assert.deepEqual(stored.tabs(checkout.checkoutId), []);
  } finally {
    await f.dispose();
  }
});

for (const kind of ['close', 'quit', 'reload'] as const)
  test(`text typed after a vetoed ${kind} Discard survives the Discard settling later`, async () => {
    const f = await fixture();
    try {
      f.editor.edit(target, 'discarded later');
      await f.editor.flush();
      // The close commits but its reply is lost, and the store can't be asked about it yet.
      f.memory.failNext('closeTab', 'Reply lost', true, 'Uncertain');
      f.memory.failNext('loadRecovery', 'Store unavailable', false, 'Unavailable');
      let done: boolean;
      if (kind === 'reload') {
        f.memory.externalWrite(target, 'reloaded');
        done = await f.editor.reload(target).catch(() => false);
      } else
        done = await answering(
          f.editor,
          () => (kind === 'close' ? f.editor.close([target]) : f.editor.prepareQuit()),
          async () => 'discard',
        );
      assert.equal(done, false);
      f.editor.edit(target, 'TYPED AFTER VETO');
      await f.editor.flush();
      // The store showed the close committed; the newer text stays, shown and stored.
      assert.equal(f.editor.buffer(target)?.text, 'TYPED AFTER VETO');
      assert.equal(f.editor.getSnapshot().recoveryReady, true);
      const stored = await f.stored();
      assert.deepEqual(
        stored.drafts.map((draft) => draft.text),
        ['TYPED AFTER VETO'],
      );
      assert.deepEqual(stored.tabs(checkout.checkoutId), ['a.ts']);
      const next = await f.restart();
      assert.equal(next.buffer(target)?.text, 'TYPED AFTER VETO');
      await next.dispose();
    } finally {
      await f.dispose();
    }
  });
