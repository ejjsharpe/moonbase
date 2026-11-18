import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { Effect, ManagedRuntime, Layer, SubscriptionRef } from 'effect';
import { type CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceStoreError } from '@moonbase/contracts/workspace-host-errors';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import * as controllerFixture from '../editor-fixture.ts';
import {
  acquireEditor,
  checkout,
  target,
  answering,
  type EditorDriver,
  fixture,
  loadStoredState,
  draftsOf,
} from '../editor-fixture.ts';
import {
  type CloseChoice,
  EditorCheckouts,
  EditorLoader,
  EditorPreservation,
  EditorSession,
  EditorTabs,
  RecoveryOutbox,
  RecoverySync,
  editorLayer,
} from '@moonbase/application/editor';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';

test('exact close prompts ignore stale answers and disposal cancels an outstanding prompt', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'A' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const editor = await acquireEditor(runtime, {
    client: makeEditorClient(runtime),
    clientId: 'prompts',
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    editor.edit(target('a.ts'), 'dirty');
    const closing = editor.close([target('a.ts')]);
    const prompt = editor.getSnapshot().closePrompt!;
    assert(prompt);
    editor.answerClose('stale-prompt', 'discard');
    assert.equal(editor.getSnapshot().closePrompt?.id, prompt.id);
    editor.answerClose(prompt.id, 'cancel');
    assert.equal(await closing, false);
    const next = editor.close([target('a.ts')]);
    // Disposal answers the outstanding prompt Cancel, or ends the close with the editor.
    const result = next.catch(() => false);
    await editor.dispose();
    assert.equal(await result, false);
    assert.equal(editor.getSnapshot().closePrompt, null);
  } finally {
    await editor.dispose();
    await runtime.dispose();
  }
});

describe('captured preservation races', () => {
  const { checkout, second, target, fixture, held, holding, observedFixture, storedRecovery } =
    controllerFixture;
  const closeAs = (editor: EditorDriver, kind: 'files' | 'checkout' | 'quit', path: string) =>
    answering(
      editor,
      () => {
        if (kind === 'files') return editor.close([target(path)]);
        if (kind === 'checkout') return editor.closeCheckout(checkout);
        return editor.prepareQuit();
      },
      async () => 'discard',
    );

  for (const kind of ['files', 'checkout', 'quit'] as const)
    test(`${kind} preservation keeps the selection and layout changed while its edit is held`, async () => {
      const f = await fixture('selection-' + kind, false);
      const h = holding({ ...f.client, watch: () => async () => {} });
      await f.editor.dispose();
      let editor = await acquireEditor(f.runtime, {
        client: h.client,
        clientId: f.editor.clientId,
      });
      try {
        await editor.load();
        await editor.openCheckout(checkout.root);
        await editor.open(target('a.ts'));
        await editor.open(target('b.ts'));
        editor.edit(target('b.ts'), 'discarded draft');
        await editor.openCheckout(second.root);
        await editor.selectCheckout(checkout);
        await editor.flush();
        await editor.dispose();
        editor = await acquireEditor(f.runtime, { client: h.client, clientId: f.editor.clientId });
        await editor.load();
        assert.equal(editor.buffer(target('a.ts')), undefined, 'clean tabs load lazily');
        const hold = h.hold('edit');
        const closing = closeAs(editor, kind, 'b.ts');
        await hold.entered;
        void editor.selectCheckout(second);
        editor.tree(second, { focus: 'folder', expanded: ['folder'] });
        editor.resizeSidebar(321);
        hold.release();
        assert.equal(await closing, true);
        await editor.flush();
        const live = editor.getSnapshot().recovery,
          durable = await storedRecovery(f.client, editor.clientId);
        for (const state of [live, durable.state]) {
          assert.equal(state.selectedCheckoutId, second.checkoutId);
          assert.equal(state.sidebarWidth, 321);
        }
        assert.deepEqual(live.views.get(second.checkoutId)!.tree.expanded, ['folder']);
        assert.deepEqual(durable.state.views[second.checkoutId].tree.expanded, ['folder']);
        assert.deepEqual(durable.drafts, []);
        assert.equal(editor.buffer(target('a.ts')), undefined);
        if (kind === 'files') {
          assert.equal(await editor.open(target('a.ts')), true);
          assert.equal(editor.buffer(target('a.ts'))!.text, 'const a = 1;');
        }
      } finally {
        await editor.dispose();
        await f.dispose();
      }
    });

  for (const kind of ['files', 'checkout', 'quit'] as const)
    test(`${kind} preservation whose discard reply is lost shows on restart what the editor shows`, async () => {
      const f = await fixture('lost-discard-' + kind, false);
      try {
        await f.editor.open(target('b.ts'));
        f.editor.edit(target('b.ts'), 'persisted draft');
        await f.editor.flush();
        f.memory.failNext('closeTab', 'Lost discard reply', true);
        const closed = await closeAs(f.editor, kind, 'b.ts');
        await f.editor.flush().catch(() => {});
        const shown = f.editor.buffer(target('b.ts'))?.text === 'persisted draft';
        assert.equal(closed, !shown, 'a close either completes or keeps the draft');
        const durable = await storedRecovery(f.client, f.editor.clientId);
        assert.equal(
          durable.drafts.find((d) => d.target.path === 'b.ts')?.text,
          shown ? 'persisted draft' : undefined,
        );
        await f.editor.dispose();
        const restarted = await acquireEditor(f.runtime, {
          clientId: f.editor.clientId,
          client: { ...f.client, watch: () => async () => {} },
        });
        try {
          await restarted.load();
          assert.equal(restarted.buffer(target('b.ts'))?.text === 'persisted draft', shown);
        } finally {
          await restarted.dispose();
        }
      } finally {
        await f.dispose();
      }
    });

  test('a layout failure after a committed close does not bring the discarded draft back', async () => {
    const f = await fixture('committed-close', false);
    try {
      await f.editor.open(target('b.ts'));
      f.editor.edit(target('b.ts'), 'committed discard');
      await f.editor.flush();
      f.memory.failNext('updateLayout', 'Layout unavailable');
      await answering(
        f.editor,
        () => f.editor.close([target('b.ts')]),
        async () => 'discard',
      );
      assert.equal(f.editor.buffer(target('b.ts')), undefined);
      await f.editor.flush();
      const durable = await storedRecovery(f.client, f.editor.clientId);
      assert.deepEqual(durable.drafts, []);
      assert.equal(durable.tabs().includes('b.ts'), false);
      assert.equal(f.editor.getSnapshot().recoveryReady, true);
    } finally {
      await f.dispose();
    }
  });

  test("an observation already awaiting recovery cannot remap Reload's captured draft or erase it on restart", async () => {
    const f = await observedFixture('reload-observation'),
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
      const { drafts } = await storedRecovery(f.raw, f.editor.clientId);
      assert.equal(drafts[0].text, 'precious moved draft');
      await f.editor.dispose();
      const restarted = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => async () => {} },
      });
      try {
        await restarted.load();
        assert.equal(restarted.buffer(target('renamed.ts'))?.text, 'precious moved draft');
      } finally {
        await restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      allowObservation.release();
      allowRead.release();
      await f.dispose();
    }
  });

  test('an observation read before a close cannot resurrect its discarded draft', async () => {
    const f = await observedFixture('close-observation'),
      observing = held(),
      allowObservation = held();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'consented captured draft');
      await f.editor.flush();
      let delayObservation = true;
      f.transport.command = async (name, input, options) => {
        const result = await f.clientCommand(name, input, options);
        if (name === 'loadRecovery' && delayObservation) {
          delayObservation = false;
          observing.release();
          await allowObservation.promise;
        }
        return result;
      };
      const observation = f.editor.reconcileRecovery();
      await observing.promise;
      const closing = answering(
        f.editor,
        () => f.editor.close([target('a.ts')]),
        async () => 'discard',
      );
      const sources = await f.raw.command('inspectEntries', { checkout, paths: ['a.ts'] });
      await f.raw.command('mutate', {
        checkout,
        clientId: 'foreign',
        id: 'around-close',
        sources,
        kind: 'move',
        destination: 'renamed.ts',
      });
      allowObservation.release();
      await observation;
      assert.equal(await closing, true);
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      const hasDraft = (editor: EditorDriver) =>
        editor.getSnapshot().buffers.some((buffer) => buffer.text === 'consented captured draft');
      assert.equal(hasDraft(f.editor), false);
      assert.equal(
        f.editor
          .getSnapshot()
          .recovery.views.get(checkout.checkoutId)!
          .openFiles.includes('renamed.ts'),
        false,
      );
      const durable = await storedRecovery(f.raw, f.editor.clientId);
      assert.deepEqual(durable.drafts, []);
      assert.equal(durable.tabs().includes('renamed.ts'), false);
      await f.editor.dispose();
      const restarted = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => async () => {} },
      });
      try {
        await restarted.load();
        assert.equal(hasDraft(restarted), false);
      } finally {
        await restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      allowObservation.release();
      await f.dispose();
    }
  });

  test('a captured Save stays saved while a foreign move during it re-paths a cancelled sibling', async () => {
    const f = await observedFixture('captured-save');
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
        await answering(
          f.editor,
          () => f.editor.close([target('a.ts'), target('b.ts')]),
          async (buffer) => (buffer.target.path === 'a.ts' ? 'save' : 'cancel'),
        ),
        false,
      );
      await f.editor.reconcileRecovery();
      assert.equal(f.editor.buffer(target('a.ts'))?.disk.text, 'saved before cancel');
      assert.equal((await f.raw.command('readFile', target('a.ts'))).text, 'saved before cancel');
      assert.equal(f.editor.buffer(target('renamed.ts'))?.text, 'retained moved sibling');
      const stored = await storedRecovery(f.raw, f.editor.clientId);
      assert.equal(
        stored.drafts.find((draft) => draft.target.path === 'renamed.ts')?.text,
        'retained moved sibling',
      );
      const { operations } = await f.raw.command('loadRecovery', { clientId: f.editor.clientId });
      assert.equal(operations.length, 0);
      assert.equal(f.memory.stats.saves, 1);
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      await f.dispose();
    }
  });

  test('an admitted observer acknowledgement stays completed when its response crosses a Reload lock', async () => {
    const f = await observedFixture('ack-boundary'),
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
      const { drafts } = await storedRecovery(f.raw, f.editor.clientId);
      assert.equal(drafts[0].text, 'acknowledged dirty draft');
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      releaseAck.release();
      releaseRead.release();
      await f.dispose();
    }
  });

  test('a copied draft discarded before the copy replies stays discarded, and newer edits there are kept', async () => {
    const f = await observedFixture('copy-close'),
      admitted = held(),
      reply = held();
    try {
      await f.editor.open(target('a.ts'), { view: 'file' });
      f.editor.edit(target('a.ts'), 'source draft');
      await f.editor.flush();
      const sources = await f.editor.inspect(checkout, ['a.ts']);
      f.transport.command = async (name, input, options) => {
        const result = await f.clientCommand(name, input, options);
        if (name === 'mutate') {
          admitted.release();
          await reply.promise;
        }
        return result;
      };
      const copying = f.editor.mutate({ checkout, kind: 'copy', sources, destination: 'copy.ts' });
      await admitted.promise;
      await f.editor.reconcileRecovery();
      assert.equal(f.editor.buffer(target('copy.ts'))?.text, 'source draft');
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.close([target('copy.ts')]),
          async () => 'discard',
        ),
        true,
      );
      assert.equal(f.editor.buffer(target('copy.ts')), undefined);
      reply.release();
      await copying;
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      assert.equal(f.editor.buffer(target('copy.ts')), undefined);
      let stored = await storedRecovery(f.raw, f.editor.clientId);
      assert.equal(
        stored.drafts.some((d) => d.target.path === 'copy.ts'),
        false,
      );
      assert.equal(stored.tabs().includes('copy.ts'), false);
      assert.equal((await f.raw.command('readFile', target('copy.ts'))).text, 'const a = 1;');
      assert.equal(await f.editor.open(target('copy.ts')), true);
      f.editor.edit(target('copy.ts'), 'later explicit edits');
      await f.editor.reconcileRecovery();
      await f.editor.flush();
      stored = await storedRecovery(f.raw, f.editor.clientId);
      assert.equal(
        stored.drafts.find((d) => d.target.path === 'copy.ts')?.text,
        'later explicit edits',
      );
      await f.editor.dispose();
      const restarted = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => async () => {} },
      });
      try {
        await restarted.load();
        assert.equal(restarted.buffer(target('copy.ts'))?.text, 'later explicit edits');
        assert.equal(restarted.buffer(target('a.ts'))?.text, 'source draft');
      } finally {
        await restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      reply.release();
      await f.dispose();
    }
  });
});

test('captured close defers Discards; earlier Save remains a fact after later Cancel', async () => {
  const f = await fixture();
  try {
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      await f.editor.open(target(path));
      f.editor.edit(target(path), 'edit ' + path);
    }
    const choices: CloseChoice[] = ['save', 'discard', 'cancel'];
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.close([target('a.ts'), target('b.ts'), target('c.ts')]),
        async () => choices.shift()!,
      ),
      false,
    );
    assert.equal(
      f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.openFiles.length,
      3,
    );
    assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, 'edit a.ts');
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'edit b.ts');
    assert.equal(f.editor.buffer(target('c.ts'))!.text, 'edit c.ts');
    f.memory.failNext('closeTab');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.close([target('b.ts')]),
        async () => 'discard',
      ),
      false,
    );
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'edit b.ts');
    await f.editor.flush();
    assert(
      draftsOf(await loadStoredState(f.client, f.editor.clientId)).some(
        (d) => d.target.path === 'b.ts' && d.text === 'edit b.ts',
      ),
    );
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.close([target('b.ts')]),
        async () => 'discard',
      ),
      true,
    );
    assert.equal(f.editor.buffer(target('b.ts')), undefined);
    await f.editor.reopen(checkout);
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'second');
  } finally {
    await f.dispose();
  }
});

test('reopen restores batch order/view/position and reads current source rather than discarded text', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'), { view: 'staged' });
    await f.editor.open(target('b.ts'));
    f.editor.position(target('a.ts'), 'staged', { line: 1, column: 4, top: 18, left: 2 });
    await answering(
      f.editor,
      () => f.editor.close([target('a.ts'), target('b.ts')]),
      async () => 'discard',
    );
    f.memory.externalWrite(target('b.ts'), 'latest source');
    await f.editor.reopen(checkout);
    const selected = f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!;
    assert.deepEqual(selected.openFiles, ['a.ts', 'b.ts']);
    assert.equal(selected.fileViews.get('a.ts'), 'staged');
    assert.equal(selected.positions.get('a.ts')!.staged?.column, 4);
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'latest source');
    await f.editor.navigate(checkout, -1);
    assert.equal(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
  } finally {
    await f.dispose();
  }
});

test('pending commands retain newer live text and close cannot cross an unresolved Save', async () => {
  const f = await fixture();
  let received!: () => void, release!: () => void;
  const admitted = new Promise<void>((resolve) => {
      received = resolve;
    }),
    delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
  const client: WorkspaceClient = {
    ...f.client,
    async command(name, input, options) {
      const result = await f.client.command(name, input, options);
      if (name === 'saveFile') {
        received();
        await delayed;
      }
      return result;
    },
  };
  const editor = await acquireEditor(f.runtime, { client, clientId: 'pending-save' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.open(target('a.ts'));
    editor.edit(target('a.ts'), 'captured save');
    await editor.flush();
    const save = editor.save(target('a.ts'));
    await admitted;
    editor.edit(target('a.ts'), 'newer live edit');
    assert.equal(
      await answering(
        editor,
        () => editor.prepareQuit(),
        async () => 'discard',
      ),
      false,
    );
    release();
    assert.equal(await save, false);
    assert.equal(editor.buffer(target('a.ts'))!.disk.text, 'captured save');
    assert.equal(editor.buffer(target('a.ts'))!.text, 'newer live edit');
    await editor.flush();
    assert.deepEqual(
      draftsOf(await loadStoredState(f.client, editor.clientId)).map((d) => d.text),
      ['newer live edit'],
    );
  } finally {
    release();
    await editor.dispose();
    await f.dispose();
  }
});

test('Quit uses the same deferred preservation gate and a failed discard keeps all edits', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'dirty');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.prepareQuit(),
        async () => 'cancel',
      ),
      false,
    );
    f.memory.failNext('closeTab');
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.prepareQuit(),
        async () => 'discard',
      ),
      false,
    );
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty');
    await f.editor.flush();
    assert.deepEqual(
      draftsOf(await loadStoredState(f.client, f.editor.clientId)).map((d) => d.text),
      ['dirty'],
    );
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.prepareQuit(),
        async () => 'save',
      ),
      true,
    );
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty');
  } finally {
    await f.dispose();
  }
});

test('checkout close retains exact metadata and reopens its order, comparison, positions and active file', async () => {
  const f = await fixture('checkout-memory', false);
  try {
    await f.editor.open(target('a.ts'), { view: 'staged' });
    await f.editor.open(target('b.ts'));
    f.editor.position(target('a.ts'), 'staged', { line: 1, column: 5, top: 12, left: 2 });
    f.editor.reorder(checkout, 'b.ts', 0);
    const before = f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!;
    assert(before);
    assert.deepEqual(f.editor.getSnapshot().recovery.openCheckoutIds, [checkout.checkoutId]);
    await answering(
      f.editor,
      () => f.editor.closeCheckout(checkout),
      async () => 'discard',
    );
    const closed = f.editor.getSnapshot().recovery;
    assert.deepEqual(closed.checkouts, [checkout]);
    assert.deepEqual(closed.openCheckoutIds, []);
    assert.deepEqual(closed.views.get(checkout.checkoutId), before);
    assert(closed.recentFiles.length);
    await f.editor.openCheckout(checkout.root);
    assert.deepEqual(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!, before);
    assert.equal(f.editor.buffer(target('b.ts'))!.text, 'second');
    assert.equal(await f.editor.reopen(checkout), false);
  } finally {
    await f.dispose();
  }
});

describe('Quit preparation on its own', () => {
  const checkout: CheckoutTarget = {
    hostId: 'local',
    checkoutId: 'quit',
    projectId: 'project',
    root: '/memory/quit',
    vcs: 'git',
    branch: 'main',
    worktree: 'main',
  };

  test('a failed final layout edit vetoes Quit until a later flush keeps it', async () => {
    const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original' } }]);
    const base = ManagedRuntime.make(memory.layer);
    const store = await base.runPromise(Effect.service(WorkspaceService));
    let loseLayout = false;
    const workspace = Layer.succeed(WorkspaceService, {
      ...store,
      updateLayout: (input) =>
        loseLayout
          ? Effect.fail(new WorkspaceStoreError({ failure: 'publication' }))
          : store.updateLayout(input),
    });
    const runtime = ManagedRuntime.make(
      Layer.provideMerge(editorLayer({ clientId: 'quit' }), workspace),
    );
    const target = { checkout, path: 'a.ts' };
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* (yield* EditorLoader).load;
          const opened = yield* (yield* EditorCheckouts).openCheckout(checkout.root);
          const file = { ...target, checkout: opened };
          const tabs = yield* EditorTabs;
          yield* tabs.open(file);
          yield* (yield* RecoverySync).flush;
          const session = yield* EditorSession;
          const preservation = yield* EditorPreservation;
          const fence = (open: boolean) => session.update((s) => ({ ...s, admissionsOpen: open }));
          // The last change before Quit is a layout edit the store loses.
          loseLayout = true;
          yield* tabs.position(file, 'file', { line: 1, column: 7, top: 20, left: 0 });
          yield* fence(false);
          assert.equal(yield* preservation.finishQuitPreparation, false);
          assert.notEqual(
            (yield* SubscriptionRef.get((yield* RecoveryOutbox).state)).failure,
            undefined,
          );
          assert.equal(yield* preservation.recoveryReady, false);
          // Quit may go once a later flush keeps it.
          yield* fence(true);
          loseLayout = false;
          yield* (yield* RecoverySync).flush;
          yield* fence(false);
          assert.equal(yield* preservation.finishQuitPreparation, true);
          const { state } = yield* store.loadRecovery({ clientId: 'quit' });
          const id = state.buffers.find((buffer) => buffer.target.path === 'a.ts')!.id;
          assert.deepEqual(state.views[opened.checkoutId].positions[id].file, {
            line: 1,
            column: 7,
            top: 20,
            left: 0,
          });
        }),
      );
    } finally {
      await runtime.dispose();
      await base.dispose();
    }
  });
});
