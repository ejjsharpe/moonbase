import { getFailureCode, fileKey } from '@moonbase/application/editor';
import {
  acquireEditor,
  answering,
  held,
  storedRecovery,
  type EditorDriver,
  checkout,
  target,
  fixture,
  loadStoredState,
  draftsOf,
} from '../editor-fixture.ts';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ManagedRuntime } from 'effect';
import {
  toWorkspaceClient as makeEditorClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
} from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

describe('Save races', () => {
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
  async function fixture(wrap: (raw: WorkspaceClient) => WorkspaceClient = (raw) => raw) {
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
    const restarted: EditorDriver[] = [];
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
    (raw: WorkspaceClient): WorkspaceClient => {
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

  const quit = (editor: EditorDriver, choice: 'discard' | 'cancel') =>
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
        assert(
          f.editor
            .getSnapshot()
            .recovery.views.get(checkout.checkoutId)!
            .openFiles.includes('a.ts'),
        );
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

  test('text typed while a Save settles is drafted over the text the Save wrote', async () => {
    const written = held(),
      reply = held();
    const f = await fixture((raw) => ({
      ...raw,
      async command(name, input, options) {
        const result = await raw.command(name, input, options);
        if (name === 'saveFile' && (input as CommandInput<'saveFile'>).target.path === 'a.ts') {
          written.release();
          await reply.promise;
        }
        return result;
      },
    }));
    try {
      f.editor.edit(target('a.ts'), 'A');
      await f.editor.flush();
      f.editor.edit(target('a.ts'), 'saved A');
      const saving = f.editor.save(target('a.ts'));
      await written.promise;
      f.editor.edit(target('a.ts'), 'typed during Save');
      await f.editor.flush();
      reply.release();
      assert.equal(await saving, false, 'the newer text is still unsaved');
      await f.editor.flush();
      const draft = (await f.stored()).drafts.find((d) => d.target.path === 'a.ts')!;
      assert.equal(draft.text, 'typed during Save');
      assert.equal(draft.disk.text, 'saved A');
    } finally {
      reply.release();
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
      const cancelled = assert.rejects(f.editor.save(target('a.ts')), /Editor disposed/);
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
        (error) => getFailureCode(error) === 'InvalidInput',
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
});

describe('saves and reloads', () => {
  test('external-change conflict retains dirty text and baseline; Overwrite checks the observed version again', async () => {
    const f = await fixture();
    try {
      await f.editor.open(target('a.ts'));
      const baseline = f.editor.buffer(target('a.ts'))!.disk;
      f.editor.edit(target('a.ts'), 'dirty');
      f.memory.externalWrite(target('a.ts'), 'external');
      assert.equal(await f.editor.save(target('a.ts')), false);
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty');
      assert.deepEqual(f.editor.buffer(target('a.ts'))!.disk, baseline);
      await f.editor.open(target('a.ts'), { view: 'conflict' });
      assert.equal(
        f.editor.getSnapshot().comparisons[fileKey(target('a.ts'))].original,
        'external',
      );
      f.memory.externalWrite(target('a.ts'), 'external again');
      assert.equal(await f.editor.save(target('a.ts'), true), false);
      assert.equal(f.editor.buffer(target('a.ts'))!.conflict!.text, 'external again');
      assert.equal(await f.editor.save(target('a.ts'), true), true);
      assert.equal((await f.client.command('readFile', target('a.ts'))).text, 'dirty');
    } finally {
      await f.dispose();
    }
  });

  test('a Reload whose discard fails keeps the edits; Cancel keeps them too', async () => {
    const f = await fixture();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'dirty');
      f.memory.externalWrite(target('a.ts'), 'external');
      await f.editor.save(target('a.ts'));
      f.memory.failNext('closeTab');
      await assert.rejects(f.editor.reload(target('a.ts')));
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty');
      assert.equal(f.editor.getSnapshot().recoveryFailed, true);
      f.editor.cancelConflict(target('a.ts'));
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'dirty');
      await f.editor.flush();
      assert.equal(f.editor.getSnapshot().recoveryFailed, false);
      assert.deepEqual(
        draftsOf(await loadStoredState(f.client, f.editor.clientId)).map((d) => d.text),
        [f.editor.buffer(target('a.ts'))!.text],
      );
      assert.equal(await f.editor.reload(target('a.ts')), true);
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'external');
      assert.deepEqual(draftsOf(await loadStoredState(f.client, f.editor.clientId)), []);
    } finally {
      await f.dispose();
    }
  });

  test('lost Save response retries its immutable payload once, preserving newer edits', async () => {
    const f = await fixture();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'first edit');
      f.memory.failNext('saveFile', 'Response lost after replacement', true);
      await assert.rejects(f.editor.save(target('a.ts')));
      const request = f.editor.buffer(target('a.ts'))!.pendingSave;
      assert.equal(f.memory.stats.saves, 1);
      f.editor.edit(target('a.ts'), 'newer edit');
      assert.equal(
        await answering(
          f.editor,
          () => f.editor.close([target('a.ts')]),
          async () => 'discard',
        ),
        false,
      );
      assert.equal(await f.editor.save(target('a.ts')), false);
      assert.equal(f.memory.stats.saves, 1);
      assert.equal(f.editor.buffer(target('a.ts'))!.disk.text, request!.text);
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'newer edit');
      assert.equal(await f.editor.save(target('a.ts')), true);
      assert.equal(f.memory.stats.saves, 2);
    } finally {
      await f.dispose();
    }
  });

  test('a file that exists but fails to read saves over itself, not as a new file', async () => {
    const f = await fixture();
    try {
      await f.editor.open(target('a.ts'));
      f.editor.edit(target('a.ts'), 'kept through a failed read');
      f.memory.failNext('readFile', 'Permission denied', false, 'Unavailable');
      await f.editor.open(target('a.ts'));
      assert.equal(f.editor.buffer(target('a.ts'))!.text, 'kept through a failed read');
      assert.equal(await f.editor.save(target('a.ts')), true);
      assert.equal(
        (await f.client.command('readFile', target('a.ts'))).text,
        'kept through a failed read',
      );
      // A folder listing cut short, which leaves the file out, doesn't show it is gone either.
      const cut: typeof f.client = {
        ...f.client,
        async command(name, input, options) {
          const output = await f.client.command(name, input, options);
          return name === 'listDirectory' ? { ...output, entries: [], partial: true } : output;
        },
      };
      const other = await acquireEditor(f.runtime, { client: cut, clientId: 'partial-listing' });
      try {
        await other.load();
        await other.openCheckout(checkout.root);
        await other.open(target('b.ts'));
        other.edit(target('b.ts'), 'kept through a cut listing');
        f.memory.failNext('readFile', 'Permission denied', false, 'Unavailable');
        await other.open(target('b.ts'));
        assert.equal(await other.save(target('b.ts')), true);
        assert.equal(
          (await f.client.command('readFile', target('b.ts'))).text,
          'kept through a cut listing',
        );
      } finally {
        await other.dispose();
      }
    } finally {
      await f.dispose();
    }
  });
});
