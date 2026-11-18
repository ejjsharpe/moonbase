import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationError, type FileTarget } from '@moonbase/contracts/workspace';
import type { WorkspaceClient as EditorClient } from '@moonbase/application/testing/editor-fixture';
import {
  answering,
  deferred,
  fixture,
  listDrafts,
  listTabs,
  until,
} from './editor-workspace-fixture.ts';

// Never losing unsaved work, exhaustively: each case runs the public editor on the real recovery
// store, then restarts (a fresh runtime and editor with the same client ID, loading from the
// store) and checks what restored and what is on disk.

test(
  'an edit not yet committed is not claimed durable, and a crash restores the last committed text',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const editor = await f.editor('crash'),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'b.ts' };
      await editor.open(target);
      editor.edit(target, 'COMMITTED\n');
      assert.equal(editor.getSnapshot().recoveryReady, false);
      await editor.flush();
      assert.equal(editor.getSnapshot().recoveryReady, true);
      editor.edit(target, 'NEVER COMMITTED\n');
      assert.equal(editor.getSnapshot().recoveryReady, false);

      await f.restart();
      const restored = await f.editor('crash');
      assert.equal(restored.buffer(target)?.text, 'COMMITTED\n');
      assert.equal(restored.buffer(target)?.disk.text, 'B\n');
      assert.equal(readFileSync(join(f.roots[0], 'b.ts'), 'utf8'), 'B\n');
    } finally {
      await f.close();
    }
  },
);

test(
  'text typed while a Save is on the host stays a draft over the saved text',
  { timeout: 30000 },
  async () => {
    const f = fixture(),
      saved = deferred(),
      reply = deferred();
    const held: EditorClient = {
      ...f.client,
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (name === 'saveFile') {
          saved.resolve();
          await reply.promise;
        }
        return result;
      },
    };
    try {
      const editor = await f.editor('save-race', held),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'a.ts' };
      await editor.open(target);
      editor.edit(target, 'SAVED\n');
      const saving = editor.save(target);
      await saved.promise;
      editor.edit(target, 'TYPED DURING SAVE\n');
      reply.resolve();
      assert.equal(await saving, false);
      await editor.flush();
      assert.equal(editor.buffer(target)?.text, 'TYPED DURING SAVE\n');
      assert.equal(editor.buffer(target)?.disk.text, 'SAVED\n');
      assert.equal(editor.getSnapshot().recoveryReady, true);

      await f.restart();
      const restored = await f.editor('save-race');
      assert.equal(restored.buffer(target)?.text, 'TYPED DURING SAVE\n');
      assert.equal(restored.buffer(target)?.disk.text, 'SAVED\n');
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'SAVED\n');
    } finally {
      reply.resolve();
      await f.close();
    }
  },
);

test(
  'a Save whose reply is lost keeps the text, restores it, and writes the file once',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let lose = true;
    const requests = new Set<string>();
    const lossy: EditorClient = {
      ...f.client,
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (name === 'saveFile') {
          requests.add((input as { requestId: string }).requestId);
          if (lose) {
            lose = false;
            throw new ApplicationError({ code: 'Uncertain', message: 'Controlled reply loss' });
          }
        }
        return result;
      },
    };
    try {
      const editor = await f.editor('lost-save', lossy),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'a.ts' };
      await editor.open(target);
      editor.edit(target, 'SAVED ONCE\n');
      await assert.rejects(editor.save(target));
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'SAVED ONCE\n');
      const written = statSync(join(f.roots[0], 'a.ts')).ino;
      assert.equal(editor.buffer(target)?.text, 'SAVED ONCE\n');
      editor.edit(target, 'NEWER AFTER LOST REPLY\n');
      await editor.flush();

      await f.restart();
      const restored = await f.editor('lost-save');
      assert.equal(restored.buffer(target)?.text, 'NEWER AFTER LOST REPLY\n');
      // The lost Save was sent once and replaced the file once: nothing replayed it.
      assert.equal(requests.size, 1);
      assert.equal(statSync(join(f.roots[0], 'a.ts')).ino, written);
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'SAVED ONCE\n');
      // The draft is over the saved text (the store settled the Save) or over the text it was
      // edited from, and then saving it is a conflict that writes nothing.
      const settled = restored.buffer(target)?.disk.text === 'SAVED ONCE\n';
      if (!settled) assert.equal(restored.buffer(target)?.disk.text, 'WORKING\n');
      assert.equal(await restored.save(target), settled);
      assert.equal(
        readFileSync(join(f.roots[0], 'a.ts'), 'utf8'),
        settled ? 'NEWER AFTER LOST REPLY\n' : 'SAVED ONCE\n',
      );
      assert.equal(restored.buffer(target)?.text, 'NEWER AFTER LOST REPLY\n');
    } finally {
      await f.close();
    }
  },
);

test(
  'a pending edit follows its file through a move and stays at its path through Trash',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let trashed = '';
    try {
      const editor = await f.editor('move-trash'),
        checkout = await editor.openCheckout(f.roots[0]),
        moving = { checkout, path: 'b.ts' },
        moved = { checkout, path: 'moved.ts' },
        trashing = { checkout, path: 'folder/nested.ts' };
      await editor.open(moving);
      await editor.open(trashing);
      editor.edit(moving, 'MOVING DRAFT\n');
      editor.edit(trashing, 'TRASHED DRAFT\n');
      const move = await editor.mutate({
        checkout,
        kind: 'move',
        sources: await editor.inspect(checkout, ['b.ts']),
        destination: 'moved.ts',
      });
      assert.equal(move.outcome, 'completed');
      const trash = await editor.mutate({
        checkout,
        kind: 'trash',
        sources: await editor.inspect(checkout, ['folder/nested.ts']),
      });
      assert.equal(trash.outcome, 'completed');
      trashed = trash.items[0].message?.replace('macOS Trash: ', '') ?? '';
      assert.equal(editor.buffer(moving), undefined);
      assert.equal(editor.buffer(moved)?.text, 'MOVING DRAFT\n');
      assert.equal(editor.buffer(trashing)?.text, 'TRASHED DRAFT\n');

      await f.restart();
      const restored = await f.editor('move-trash');
      assert.equal(restored.buffer(moving), undefined);
      assert.equal(restored.buffer(moved)?.text, 'MOVING DRAFT\n');
      assert.equal(restored.buffer(moved)?.disk.text, 'B\n');
      assert.equal(restored.buffer(trashing)?.text, 'TRASHED DRAFT\n');
      assert.equal(readFileSync(join(f.roots[0], 'moved.ts'), 'utf8'), 'B\n');
      assert.equal(existsSync(join(f.roots[0], 'b.ts')), false);
      assert.equal(existsSync(join(f.roots[0], 'folder/nested.ts')), false);
    } finally {
      if (trashed.includes('/.Trash/') && existsSync(trashed)) rmSync(trashed);
      await f.close();
    }
  },
);

test(
  "another window's move over a file with text not yet sent keeps that text beside it",
  { timeout: 30000 },
  async () => {
    const f = fixture(),
      entered = deferred(),
      release = deferred();
    let hold = false;
    const gated: EditorClient = {
      ...f.client,
      async command(name, input, options) {
        if (hold && name === 'updateDraft') {
          entered.resolve();
          await release.promise;
        }
        return f.client.command(name, input, options);
      },
    };
    try {
      mkdirSync(join(f.roots[0], 'dest'));
      writeFileSync(join(f.roots[0], 'dest/b.ts'), 'REPLACED\n');
      const x = await f.editor('window-x', gated),
        y = await f.editor('window-y'),
        checkout = await x.openCheckout(f.roots[0]);
      await y.openCheckout(f.roots[0]);
      const source = { checkout, path: 'b.ts' },
        destination = { checkout, path: 'dest/b.ts' },
        kept = { checkout, path: 'dest/b (unsaved).ts' };
      await x.open(source, { intent: 'keep' });
      await x.open(destination, { intent: 'keep' });
      await x.flush();
      hold = true;
      x.edit(destination, 'X UNSENT\n');
      // The edit is on its way but the store has not taken it: the buffer there is still clean.
      await entered.promise;
      const move = await y.mutate({
        checkout,
        kind: 'move',
        sources: await y.inspect(checkout, ['b.ts']),
        destination: 'dest/b.ts',
        replacements: await y.inspect(checkout, ['dest/b.ts']),
      });
      assert.equal(move.outcome, 'completed', JSON.stringify(move));
      hold = false;
      release.resolve();
      await until(
        async () => {
          await x.reconcileRecovery();
          return x.buffer(kept)?.text;
        },
        (text) => text === 'X UNSENT\n',
      );
      await x.flush();
      assert.equal(x.buffer(destination)?.text, 'B\n');
      assert(x.getSnapshot().errors.some((error) => error.includes(kept.path)));
      assert.equal(readFileSync(join(f.roots[0], 'dest/b.ts'), 'utf8'), 'B\n');

      await f.restart();
      const restored = await f.editor('window-x');
      assert.equal(restored.buffer(kept)?.text, 'X UNSENT\n');
      assert.equal(restored.buffer(kept)?.disk.text, 'REPLACED\n');
      assert.equal(restored.buffer(destination)?.text, 'B\n');
      // Saving the kept text creates its file (it never replaces one) and leaves no draft.
      await restored.open(kept);
      assert.equal(await restored.save(kept, true), true);
      assert.equal(readFileSync(join(f.roots[0], kept.path), 'utf8'), 'X UNSENT\n');
      assert.equal(readFileSync(join(f.roots[0], 'dest/b.ts'), 'utf8'), 'B\n');
      await restored.flush();
      const state = await f.loadRecovery('window-x');
      assert.deepEqual(
        state.buffers.filter((b) => b.draft).map((b) => b.target.path),
        [],
      );
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  "two windows keep their own drafts of one file, and one's move re-paths the other's",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const x = await f.editor('window-x'),
        y = await f.editor('window-y'),
        checkout = await x.openCheckout(f.roots[0]);
      await y.openCheckout(f.roots[0]);
      const target = { checkout, path: 'b.ts' },
        moved = { checkout, path: 'moved.ts' };
      await x.open(target);
      await y.open(target);
      x.edit(target, 'X DRAFT\n');
      y.edit(target, 'Y DRAFT\n');
      await y.flush();
      const result = await x.mutate({
        checkout,
        kind: 'move',
        sources: await x.inspect(checkout, ['b.ts']),
        destination: 'moved.ts',
      });
      assert.equal(result.outcome, 'completed');
      assert.equal(x.buffer(moved)?.text, 'X DRAFT\n');
      // Y follows the store's outline of its own recovery.
      await until(
        () => y.buffer(moved)?.text,
        (text) => text === 'Y DRAFT\n',
      );
      assert.equal(y.buffer(target), undefined);
      assert.equal(listDrafts(await f.loadRecovery('window-x'))['moved.ts']?.text, 'X DRAFT\n');
      assert.equal(listDrafts(await f.loadRecovery('window-y'))['moved.ts']?.text, 'Y DRAFT\n');

      await f.restart();
      const restoredX = await f.editor('window-x'),
        restoredY = await f.editor('window-y');
      assert.equal(restoredX.buffer(moved)?.text, 'X DRAFT\n');
      assert.equal(restoredY.buffer(moved)?.text, 'Y DRAFT\n');
      assert.equal(restoredY.buffer(target), undefined);
      assert.equal(readFileSync(join(f.roots[0], 'moved.ts'), 'utf8'), 'B\n');
    } finally {
      await f.close();
    }
  },
);

test(
  'Quit sends pending edits, saves and discards as answered and keeps the tabs; Cancel keeps the drafts',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const editor = await f.editor('quit'),
        checkout = await editor.openCheckout(f.roots[0]),
        saving = { checkout, path: 'a.ts' },
        discarding = { checkout, path: 'b.ts' };
      await editor.open(saving, { intent: 'keep' });
      await editor.open(discarding, { intent: 'keep' });
      editor.edit(saving, 'A DRAFT\n');
      editor.edit(discarding, 'B DISCARDED\n');
      assert.equal(
        await answering(
          editor,
          () => editor.prepareQuit(),
          async () => 'cancel',
        ),
        false,
      );
      assert.equal(editor.buffer(saving)?.text, 'A DRAFT\n');
      assert.equal(editor.buffer(discarding)?.text, 'B DISCARDED\n');
      await editor.flush();
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(listDrafts(await f.loadRecovery('quit'))).map(([path, draft]) => [
            path,
            draft.text,
          ]),
        ),
        { 'a.ts': 'A DRAFT\n', 'b.ts': 'B DISCARDED\n' },
      );

      editor.edit(saving, 'A SAVED AT QUIT\n');
      const answered = (buffer: { target: FileTarget }) =>
        Promise.resolve(
          buffer.target.path === saving.path ? ('save' as const) : ('discard' as const),
        );
      assert.equal(await answering(editor, () => editor.prepareQuit(), answered), true);
      assert.equal(editor.getSnapshot().recoveryReady, true);
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'A SAVED AT QUIT\n');
      assert.equal(readFileSync(join(f.roots[0], 'b.ts'), 'utf8'), 'B\n');

      await f.restart();
      const stored = await f.loadRecovery('quit');
      assert.deepEqual(listDrafts(stored), {});
      assert.deepEqual(listTabs(stored, checkout.checkoutId).sort(), ['a.ts', 'b.ts']);
      const restored = await f.editor('quit');
      assert.equal(await restored.open(discarding), true);
      assert.equal(restored.buffer(discarding)?.text, 'B\n');
      assert.deepEqual(
        [...restored.getSnapshot().recovery.views.get(checkout.checkoutId)!.openFiles].sort(),
        ['a.ts', 'b.ts'],
      );
    } finally {
      await f.close();
    }
  },
);
