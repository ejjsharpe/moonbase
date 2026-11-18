import * as controllerFixture from '../editor-fixture.ts';
import {
  acquireEditor,
  answering,
  type EditorDriver,
  checkout,
  second,
  target,
  fixture,
} from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { type WorkspaceCommand, type CommandInput } from '@moonbase/contracts/workspace';
import { WorkspaceStoreError } from '@moonbase/contracts/workspace-host-errors';
import { fileKey } from '@moonbase/application/editor';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const recoveryEdits: readonly WorkspaceCommand[] = [
  'openTab',
  'closeTab',
  'updateDraft',
  'updateLayout',
];

const isRecoveryEdit = (name: WorkspaceCommand) => recoveryEdits.includes(name);

describe('checkout discovery and activation', () => {
  const { checkout, second, target, fixture, held, observedFixture } = controllerFixture;

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
    let editor = await acquireEditor(f.runtime, {
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => async () => {},
        async command(name, input, options) {
          if (hold && isRecoveryEdit(name)) {
            admit();
            await wait;
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      await f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'), { view: 'staged' });
      await editor.open(target('b.ts'));
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      await editor.dispose();
      editor = await acquireEditor(f.runtime, {
        clientId: editor.clientId,
        client: {
          ...f.client,
          watch: () => async () => {},
          async command(name, input, options) {
            if (hold && isRecoveryEdit(name)) {
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
      const closing = answering(
        editor,
        () => editor.close([target('b.ts')]),
        async () => 'discard',
      );
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
        editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.fileViews.get('a.ts'),
        'staged',
      );
      assert.equal(
        editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
        'const a = 0;',
      );
    } finally {
      release();
      finishRead();
      await editor.dispose();
      await f.dispose();
    }
  });

  for (const outcome of ['success', 'cancel', 'failure'] as const)
    test(`a selected absent survivor activates after another preservation releases (${outcome})`, async () => {
      const f = await observedFixture('r5-selected-' + outcome);
      let entered = held(),
        release = held(),
        delay = true,
        phase = 1;
      try {
        f.transport.command = async (name, input, options) => {
          if (isRecoveryEdit(name) && delay) {
            delay = false;
            entered.release();
            await release.promise;
            if (phase === 2 && outcome === 'failure')
              throw new WorkspaceStoreError({ failure: 'publication' });
          }
          return f.clientCommand(name, input, options);
        };
        const firstClose = answering(
          f.editor,
          () => f.editor.close([target('b.ts')]),
          async () => 'discard',
        );
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
        const secondClose = answering(
          f.editor,
          () => f.editor.close([target('b.ts', second)]),
          async () => {
            if (outcome === 'cancel') {
              entered.release();
              await release.promise;
              return 'cancel';
            }
            return 'discard';
          },
        );
        await entered.promise;
        await f.editor.selectCheckout(checkout);
        f.memory.externalWrite(target('a.ts'), 'latest selected source');
        release.release();
        assert.equal(await secondClose, outcome === 'success');
        assert.equal(f.editor.getSnapshot().recovery.selectedCheckoutId, checkout.checkoutId);
        assert.equal(f.editor.buffer(target('a.ts'))?.text, 'latest selected source');
        assert.equal(
          f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.fileViews.get('a.ts'),
          'staged',
        );
      } finally {
        release.release();
        await f.dispose();
      }
    });

  for (const area of ['staged', 'unstaged'] as const)
    test(`restored dirty ${area} survivor loads its remembered comparison`, async () => {
      const f = await observedFixture('r6-dirty-' + area);
      let restarted: EditorDriver | undefined;
      try {
        await f.editor.open(target('a.ts'), { view: area });
        f.editor.edit(target('a.ts'), 'restored dirty comparison');
        const baseline = f.editor.buffer(target('a.ts'))!.disk;
        await f.editor.open(target('b.ts'));
        await f.editor.flush();
        await f.editor.dispose();
        f.memory.externalWrite(target('a.ts'), 'new external working content');
        restarted = await acquireEditor(f.runtime, {
          clientId: f.editor.clientId,
          client: f.client,
        });
        await restarted.load();
        assert.equal(restarted.getSnapshot().comparisons[fileKey(target('a.ts'))], undefined);
        assert.equal(
          await answering(
            restarted,
            () => restarted!.close([target('b.ts')]),
            async () => 'discard',
          ),
          true,
        );
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
        await restarted?.dispose();
        await f.dispose();
      }
    });

  for (const area of ['staged', 'untracked'] as const)
    test(`settled ${area} comparison activation does not retry on every release`, async () => {
      const f = await observedFixture('r6-comparison-ready-' + area);
      let restarted: EditorDriver | undefined,
        reads = 0;
      try {
        await f.editor.open(target('a.ts'), { view: area });
        f.editor.edit(target('a.ts'), 'retained dirty text');
        await f.editor.open(target('b.ts'));
        await f.editor.flush();
        await f.editor.dispose();
        f.transport.command = async (name, input, options) => {
          if (name === 'readComparison') reads++;
          return f.clientCommand(name, input, options);
        };
        restarted = await acquireEditor(f.runtime, {
          clientId: f.editor.clientId,
          client: f.client,
        });
        await restarted.load();
        if (area === 'staged') f.memory.failNext('readComparison', 'Controlled comparison failure');
        assert.equal(
          await answering(
            restarted,
            () => restarted!.close([target('b.ts')]),
            async () => 'discard',
          ),
          true,
        );
        const attempts = reads;
        await restarted.selectCheckout(checkout);
        assert.equal(
          await answering(
            restarted,
            () => restarted!.prepareQuit(),
            async () => 'cancel',
          ),
          false,
        );
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
        await restarted?.dispose();
        await f.dispose();
      }
    });

  async function missingWorkingFixture(area: 'staged' | 'unstaged' | 'untracked') {
    const memory = fauxWorkspace([
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
    const client: WorkspaceClient = {
      ...raw,
      watch: () => async () => {},
      command(name, input, options) {
        if (name === 'readComparison') reads++;
        return raw.command(name, input, options);
      },
    };
    const editor = await acquireEditor(runtime, { client, clientId: 'r7-working-' + area });
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
        await editor.dispose();
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
        assert.equal(
          await answering(
            f.editor,
            () => f.editor.close([target('b.ts', second)]),
            async () => 'cancel',
          ),
          false,
        );
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
        assert.equal(
          await answering(
            f.editor,
            () => f.editor.close([target('b.ts', second)]),
            async () => 'cancel',
          ),
          false,
        );
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

test('preview replacement follows successful activation; dirty, Keep Open and reordered previews remain', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'), { intent: 'preview' });
    f.memory.failNext('readFile');
    assert.equal(await f.editor.open(target('b.ts'), { intent: 'preview' }), false);
    assert.equal(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
    await f.editor.open(target('b.ts'), { intent: 'preview' });
    assert.equal(f.editor.buffer(target('a.ts')), undefined);
    f.editor.edit(target('b.ts'), 'dirty');
    await f.editor.open(target('c.ts'), { intent: 'preview' });
    f.editor.reorder(checkout, 'c.ts', 0);
    await f.editor.open(target('a.ts'), { intent: 'preview' });
    assert.deepEqual(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.openFiles, [
      'c.ts',
      'a.ts',
      'b.ts',
    ]);
    f.editor.keepOpen(target('a.ts'));
    assert.equal(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.preview, null);
  } finally {
    await f.dispose();
  }
});

test('stale file activation cannot replace a later successful comparison', async () => {
  const f = await fixture();
  let release!: () => void, reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: WorkspaceClient = {
    ...f.client,
    async command(name, input, options) {
      if (name === 'readFile' && (input as CommandInput<'readFile'>).path === 'b.ts') {
        reading();
        await wait;
      }
      return f.client.command(name, input, options);
    },
  };
  const editor = await acquireEditor(f.runtime, { client, clientId: 'stale' });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    const slow = editor.open(target('b.ts'));
    await started;
    await editor.open(target('a.ts'), { view: 'staged' });
    release();
    assert.equal(await slow, false);
    assert.equal(editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
    assert.equal(editor.buffer(target('b.ts')), undefined);
  } finally {
    release();
    await editor.dispose();
    await f.dispose();
  }
});

test('removed checkout ignores late position recording', async () => {
  const f = await fixture();
  try {
    await f.editor.open(target('a.ts'));
    assert.equal(
      await answering(
        f.editor,
        () => f.editor.closeCheckout(checkout),
        async () => 'discard',
      ),
      true,
    );
    assert.doesNotThrow(() =>
      f.editor.position(target('a.ts'), 'file', { line: 1, column: 2, top: 0, left: 0 }),
    );
  } finally {
    await f.dispose();
  }
});

test('missing retained dirty tab stays accessible after Trash and new missing opens leave selection alone', async () => {
  const f = await fixture('trash-activation', false);
  try {
    await f.editor.open(target('a.ts'));
    f.editor.edit(target('a.ts'), 'recover these edits');
    await f.editor.mutate({
      checkout,
      sources: await f.editor.inspect(checkout, ['a.ts']),
      kind: 'trash',
    });
    await f.editor.open(target('b.ts'));
    assert.equal(await f.editor.open(target('a.ts')), true);
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'recover these edits');
    assert.equal(await f.editor.open(target('missing.ts')), false);
    assert.equal(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
    assert.match(f.editor.getSnapshot().errors.join(' '), /unavailable|retained/i);
  } finally {
    await f.dispose();
  }
});

test('a newer explicit checkout selection defeats a delayed file activation in another checkout', async () => {
  const f = await fixture('unused', false);
  await f.editor.dispose();
  let admit!: () => void, release!: () => void;
  const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  const editor = await acquireEditor(f.runtime, {
    clientId: 'checkout-race',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'readFile') {
          admit();
          await wait;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.openCheckout(second.root);
    editor.selectCheckout(checkout);
    const opening = editor.open(target('a.ts'));
    await admitted;
    editor.selectCheckout(second);
    release();
    assert.equal(await opening, false);
    assert.equal(editor.getSnapshot().recovery.selectedCheckoutId, second.checkoutId);
  } finally {
    release();
    await editor.dispose();
    await f.dispose();
  }
});

test('an unavailable retained comparison activates its buffer while a new comparison failure preserves selection', async () => {
  const f = await fixture('retained-comparison', false);
  try {
    await f.editor.open(target('a.ts'), { view: 'staged' });
    f.editor.edit(target('a.ts'), 'retain in any view');
    await f.editor.open(target('b.ts'));
    f.memory.failNext('readComparison');
    assert.equal(await f.editor.open(target('a.ts')), true);
    assert.equal(f.editor.buffer(target('a.ts'))!.text, 'retain in any view');
    f.memory.failNext('readComparison');
    assert.equal(await f.editor.open(target('new.ts'), { view: 'staged' }), false);
    assert.equal(f.editor.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
  } finally {
    await f.dispose();
  }
});

test("closing a restored active clean file loads its survivor's remembered comparison", async () => {
  const f = await fixture('close-survivor', false);
  try {
    await f.editor.open(target('a.ts'), { view: 'staged' });
    await f.editor.open(target('b.ts'));
    await f.editor.flush();
    await f.editor.dispose();
    const restored = await acquireEditor(f.runtime, {
      client: f.client,
      clientId: 'close-survivor',
    });
    try {
      await restored.load();
      assert.equal(restored.buffer(target('a.ts')), undefined);
      assert.equal(
        await answering(
          restored,
          () => restored.close([target('b.ts')]),
          async () => 'discard',
        ),
        true,
      );
      assert.equal(restored.getSnapshot().recovery.views.get(checkout.checkoutId)!.active, 'a.ts');
      assert.equal(restored.buffer(target('a.ts'))!.text, 'const a = 1;');
      assert.equal(
        restored.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
        'const a = 0;',
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await f.dispose();
  }
});
