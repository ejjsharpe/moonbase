import { acquireEditor, answering } from './editor-model-fixture.ts';
import * as controllerFixture from './editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  ApplicationError,
  type EditorClient,
  type CommandInput,
} from '@moonbase/contracts/workspace';

describe('captured preservation races', () => {
  const { checkout, second, target, fixture, held, observedFixture } = controllerFixture;

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
        watch: () => async () => {},
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
      let editor = await acquireEditor(f.runtime, { client, clientId: f.editor.clientId });
      try {
        await f.editor.dispose();
        await editor.load();
        await editor.openCheckout(checkout.root);
        await editor.open(target('a.ts'));
        await editor.open(target('b.ts'));
        await editor.openCheckout(second.root);
        editor.selectCheckout(checkout);
        await editor.flush();
        await editor.dispose();
        editor = await acquireEditor(f.runtime, { client, clientId: f.editor.clientId });
        await editor.load();
        assert.equal(editor.buffer(target('a.ts')), undefined);
        hold = true;
        let closing;
        if (kind === 'files') {
          closing = answering(
            editor,
            () => editor.close([target('b.ts')]),
            async () => 'discard',
          );
        } else {
          if (kind === 'checkout') {
            closing = answering(
              editor,
              () => editor.closeCheckout(checkout),
              async () => 'discard',
            );
          } else {
            closing = answering(
              editor,
              () => editor.prepareQuit(),
              async () => 'discard',
            );
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
        await editor.dispose();
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
    const editor = await acquireEditor(f.runtime, {
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
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'retained dirty text');
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      hold = true;
      const closing = answering(
        editor,
        () => editor.close([target('a.ts')]),
        async () => 'discard',
      );
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
      await editor.dispose();
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
    const editor = await acquireEditor(f.runtime, {
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => async () => {},
        async command(name, input, options) {
          if (hold && name === 'persistRecovery') {
            publications++;
            if (publications === 1) {
              admit();
              await wait;
            }
            if (publications === 2)
              throw new ApplicationError({
                code: 'Persistence',
                message: 'Later metadata publication failed',
              });
          }
          return f.client.command(name, input, options);
        },
      },
    });
    try {
      await f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('a.ts'));
      editor.edit(target('a.ts'), 'keep until all publications succeed');
      await editor.openCheckout(second.root);
      editor.selectCheckout(checkout);
      await editor.flush();
      hold = true;
      const closing = answering(
        editor,
        () => editor.close([target('a.ts')]),
        async () => 'discard',
      );
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
      await editor.dispose();
      await f.dispose();
    }
  });

  for (const kind of ['files', 'checkout', 'quit'] as const)
    for (const failure of ['conflict', 'lost response'] as const)
      test(`${kind} ${failure} at second publication cannot lose a persisted draft after failed close`, async () => {
        const f = await fixture('r4-durable-' + kind + failure.replaceAll(' ', '-'), false);
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
        const editor = await acquireEditor(f.runtime, {
          clientId: f.editor.clientId,
          client: {
            ...f.client,
            watch: () => async () => {},
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
          await f.editor.dispose();
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
            closing = answering(
              editor,
              () => editor.close([target('b.ts')]),
              async () => 'discard',
            );
          } else {
            if (kind === 'checkout') {
              closing = answering(
                editor,
                () => editor.closeCheckout(checkout),
                async () => 'discard',
              );
            } else {
              closing = answering(
                editor,
                () => editor.prepareQuit(),
                async () => 'discard',
              );
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
          await editor.dispose();
          const restarted = await acquireEditor(f.runtime, {
            clientId: editor.clientId,
            client: { ...f.client, watch: () => async () => {} },
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
            await restarted.dispose();
          }
        } finally {
          release();
          await editor.dispose();
          await f.dispose();
        }
      });

  for (const outcome of ['not committed', 'committed', 'competing CAS'] as const)
    test(`exact resolution of an uncertain final close (${outcome}) preserves the durable outcome and original request`, async () => {
      const f = await fixture('r4-final-' + outcome.replaceAll(' ', '-'), false);
      let armed = false,
        failed = false;
      const requests: CommandInput<'persistRecovery'>[] = [];
      const editor = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: {
          ...f.client,
          watch: () => async () => {},
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
        await f.editor.dispose();
        await editor.load();
        await editor.openCheckout(checkout.root);
        await editor.open(target('b.ts'));
        editor.edit(target('b.ts'), 'consented captured draft');
        await editor.flush();
        armed = true;
        assert.equal(
          await answering(
            editor,
            () => editor.close([target('b.ts')]),
            async () => 'discard',
          ),
          false,
        );
        const pending = editor.getSnapshot().publication;
        assert.equal(pending?.kind, 'close');
        assert.equal(editor.getSnapshot().preserving, true);
        assert.equal(editor.buffer(target('b.ts'))?.text, 'consented captured draft');
        assert.equal(
          await answering(
            editor,
            () => editor.prepareQuit(),
            async () => 'discard',
          ),
          false,
        );
        assert.equal(await editor.save(target('b.ts')), false);
        assert.equal(await editor.reload(target('b.ts')), false);
        await assert.rejects(editor.flush());
        assert.throws(() => editor.edit(target('b.ts'), 'must not be silently discarded'));
        await assert.rejects(
          editor.mutate({ checkout, kind: 'create-file', sources: [], destination: 'blocked.ts' }),
        );
        const stored = await f.client.command('loadRecovery', { clientId: editor.clientId });
        const restarted = await acquireEditor(f.runtime, {
          clientId: editor.clientId,
          client: { ...f.client, watch: () => async () => {} },
        });
        try {
          await restarted.load();
          assert.equal(
            restarted.buffer(target('b.ts'))?.text,
            outcome === 'committed' ? undefined : 'consented captured draft',
          );
        } finally {
          await restarted.dispose();
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
            await answering(
              editor,
              () => editor.close([target('b.ts')]),
              async () => {
                choices++;
                return 'cancel';
              },
            ),
            false,
          );
          assert.equal(choices, 1);
          assert.equal(
            await answering(
              editor,
              () => editor.prepareQuit(),
              async () => 'discard',
            ),
            false,
          );
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
        await editor.dispose();
        await f.dispose();
      }
    });

  test('later metadata failure cannot veto a final close already confirmed by exact receipt', async () => {
    const f = await fixture('r4-committed-close', false);
    let armed = false,
      publications = 0;
    const editor = await acquireEditor(f.runtime, {
      clientId: f.editor.clientId,
      client: {
        ...f.client,
        watch: () => async () => {},
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
      await f.editor.dispose();
      await editor.load();
      await editor.openCheckout(checkout.root);
      await editor.open(target('b.ts'));
      editor.edit(target('b.ts'), 'committed discard');
      await editor.flush();
      armed = true;
      assert.equal(
        await answering(
          editor,
          () => editor.close([target('b.ts')]),
          async () => 'discard',
        ),
        true,
      );
      assert.equal(editor.buffer(target('b.ts')), undefined);
      assert.equal(editor.getSnapshot().recovery.sidebarWidth, 318);
      await assert.rejects(editor.flush());
      assert.equal(editor.buffer(target('b.ts')), undefined);
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: editor.clientId })).state.drafts.length,
        0,
      );
    } finally {
      await editor.dispose();
      await f.dispose();
    }
  });

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
        if (name === 'getRecoveryPublication' && statusDown)
          throw new ApplicationError({ code: 'Unavailable', message: 'Status unavailable' });
        return f.clientCommand(name, input, options);
      };
      const observation = f.editor.reconcileRecovery();
      await observing.promise;
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.close([target('a.ts')]),
          async () => 'discard',
        ),
        false,
      );
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
      await f.editor.dispose();
      const restarted = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => async () => {} },
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
        await restarted.dispose();
      }
      assert.equal(f.memory.stats.mutations, 1);
    } finally {
      allowObservation.release();
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
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.close([target('copy.ts')]),
          async () => 'discard',
        ),
        true,
      );
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
      await f.editor.dispose();
      const restarted = await acquireEditor(f.runtime, {
        clientId: f.editor.clientId,
        client: { ...f.raw, watch: () => async () => {} },
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
        await restarted.dispose();
      }
    } finally {
      releasePreflight.release();
      releaseRead.release();
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
          await answering(
            f.editor,
            () => f.editor.close([target(closing)]),
            async () => (outcome === 'cancel' ? 'cancel' : 'discard'),
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
});
