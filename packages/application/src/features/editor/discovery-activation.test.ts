import { acquireEditor, answering } from '../../../test/fixtures/editor-model-fixture.ts';
import type { EditorController } from '@moonbase/application/editor';
import * as controllerFixture from '../../../test/fixtures/editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import {
  ApplicationError,
  type EditorClient,
  type CommandInput,
} from '@moonbase/contracts/workspace';
import { fileKey } from '@moonbase/application/editor';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';

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
          if (hold && name === 'persistRecovery') {
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
      await editor.dispose();
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
            throw new ApplicationError({ code: 'Uncertain', message: 'Lost final reply' });
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

  for (const area of ['staged', 'unstaged'] as const)
    test(`restored dirty ${area} survivor loads its remembered comparison`, async () => {
      const f = await observedFixture('r6-dirty-' + area);
      let restarted: EditorController | undefined;
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
      let restarted: EditorController | undefined,
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
