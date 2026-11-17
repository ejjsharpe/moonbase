import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import type { FileTarget } from '@moonbase/contracts/workspace';
import {
  mutateReplying,
  type WorkspaceClient as EditorClient,
} from '@moonbase/application/testing/editor-fixture';
import { checkoutKey, fileKey } from '@moonbase/application/editor';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { answering, code, fixture, listDrafts, listTabs } from './editor-workspace-fixture.ts';

for (const [kind, source, collision] of [
  ['copy', 'b.ts', null],
  ['move', 'bé.ts', 'be\u0301.ts'],
] as const)
  test(`batch ${kind} captures only individual destinations (${source}, collision: ${collision})`, async () => {
    const f = fixture();
    try {
      const editor = await f.editor('batch-' + kind),
        checkout = await editor.openCheckout(f.roots[0]);
      if (source !== 'b.ts') renameSync(join(f.roots[0], 'b.ts'), join(f.roots[0], source));
      mkdirSync(join(f.roots[0], 'dest'));
      writeFileSync(join(f.roots[0], 'dest/unrelated.ts'), 'RETAIN\n');
      const unrelated = { checkout, path: 'dest/unrelated.ts' };
      await editor.open(unrelated, { intent: 'keep' });
      editor.edit(unrelated, 'UNSAVED\n');
      if (collision) writeFileSync(join(f.roots[0], 'dest', collision), 'REPLACE\n');
      {
        const { result, asked } = await mutateReplying(
          editor,
          { checkout, kind, paths: [source, 'folder'] },
          'dest',
          true,
        );
        assert.equal(result.error, '');
        assert.equal(result.completed, true);
        assert.deepEqual(asked, collision ? [['dest/' + collision]] : []);
        assert.equal(readFileSync(join(f.roots[0], 'dest', source), 'utf8'), 'B\n');
        assert.equal(readFileSync(join(f.roots[0], 'dest/folder/nested.ts'), 'utf8'), 'NESTED\n');
        assert.equal(readFileSync(join(f.roots[0], 'dest/unrelated.ts'), 'utf8'), 'RETAIN\n');
        assert.equal(editor.buffer(unrelated)?.text, 'UNSAVED\n');
        const sources = await editor.list(checkout, '');
        assert.equal(
          sources.entries.some((entry) => entry.path === source),
          kind === 'copy',
        );
        assert.equal(
          sources.entries.some((entry) => entry.path === 'folder'),
          kind === 'copy',
        );
      }
    } finally {
      await f.close();
    }
  });

for (const kind of ['move', 'copy'] as const)
  test(`batch ${kind} protects open buffers inside an actual replacement`, async () => {
    const f = fixture();
    try {
      const editor = await f.editor('batch-open-replacement-' + kind),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'dest/folder/nested.ts' };
      mkdirSync(join(f.roots[0], 'dest/folder'), { recursive: true });
      writeFileSync(join(f.roots[0], target.path), 'RETAIN\n');
      await editor.open(target, { intent: 'keep' });
      editor.edit(target, 'UNSAVED\n');
      const { result } = await mutateReplying(
        editor,
        { checkout, kind, paths: ['b.ts', 'folder'] },
        'dest',
        true,
      );
      assert.equal(result.completed, false);
      assert.match(result.error, /Replacement has open buffers/);
      assert.equal(editor.buffer(target)?.text, 'UNSAVED\n');
      assert.equal(readFileSync(join(f.roots[0], target.path), 'utf8'), 'RETAIN\n');
    } finally {
      await f.close();
    }
  });

test('create and native import consumer payloads need no empty inspection and retain explicit destination/replacement authority', async () => {
  const f = fixture();
  try {
    const editor = await f.editor('import-consumer'),
      checkout = await editor.openCheckout(f.roots[0]);
    for (const [kind, destination] of [
      ['create-file', 'created.ts'],
      ['create-directory', 'created-folder'],
    ] as const) {
      assert.equal(
        (await editor.mutate({ kind, checkout, sources: [], destination })).outcome,
        'completed',
      );
    }
    assert.equal(readFileSync(join(f.roots[0], 'created.ts'), 'utf8'), '');
    assert.equal(statSync(join(f.roots[0], 'created-folder')).isDirectory(), true);
    const outside = join(f.base, 'outside.txt');
    writeFileSync(outside, 'NATIVE SOURCE\n');
    const capture = (paths: string[]) =>
      f.runtime.runPromise(
        Effect.flatMap(WorkspaceHostService, (host) =>
          Effect.map(
            host.captureImports({ checkout, clientId: editor.clientId, paths }),
            (captured) => captured.references,
          ),
        ),
      );
    const references = await capture([outside]);
    await assert.rejects(
      editor.mutate({
        kind: 'import',
        checkout,
        sources: [],
        destination: '',
        nativeReferences: references,
      }),
      code('InvalidInput'),
    );
    const replacements = await editor.inspect(checkout, ['b.ts']);
    const single = await editor.mutate({
      kind: 'import',
      checkout,
      sources: [],
      destination: 'b.ts',
      nativeReferences: references,
      replacements,
    });
    assert.equal(single.outcome, 'completed', JSON.stringify(single));
    assert.equal(readFileSync(join(f.roots[0], 'b.ts'), 'utf8'), 'NATIVE SOURCE\n');
    assert.equal(readFileSync(outside, 'utf8'), 'NATIVE SOURCE\n');
    await assert.rejects(
      editor.mutate({
        kind: 'import',
        checkout,
        sources: [],
        destination: 'replayed.txt',
        nativeReferences: references,
      }),
      code('Unauthorized'),
    );
    const second = join(f.base, 'second.txt');
    writeFileSync(second, 'SECOND SOURCE\n');
    writeFileSync(join(f.roots[0], 'outside.txt'), 'OLD DESTINATION\n');
    const batch = await capture([outside, second]);
    const retained = { checkout, path: 'folder/nested.ts' };
    await editor.open(retained, { intent: 'keep' });
    editor.edit(retained, 'UNSAVED\n');
    await assert.rejects(
      editor.mutate({
        kind: 'import',
        checkout,
        sources: [],
        destination: 'folder',
        nativeReferences: batch,
      }),
      /Replacement has open buffers/,
    );
    const result = await editor.mutate({
      kind: 'import',
      checkout,
      sources: [],
      destination: '',
      nativeReferences: batch,
      replacements: await editor.inspect(checkout, ['outside.txt']),
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(readFileSync(join(f.roots[0], 'outside.txt'), 'utf8'), 'NATIVE SOURCE\n');
    assert.equal(readFileSync(join(f.roots[0], 'second.txt'), 'utf8'), 'SECOND SOURCE\n');
    assert.equal(readFileSync(join(f.roots[0], retained.path), 'utf8'), 'NESTED\n');
    assert.equal(editor.buffer(retained)?.text, 'UNSAVED\n');
  } finally {
    await f.close();
  }
});

test(
  'real Git comparisons share a working buffer and exact-checkout recovery survives a fresh runtime',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const editor = await f.editor('comparison');
      const alpha = await editor.openCheckout(f.roots[0]),
        beta = await editor.openCheckout(f.roots[1]);
      const target = { checkout: alpha, path: 'a.ts' },
        other = { checkout: beta, path: 'a.ts' };
      assert.equal(await editor.open(target), true);
      editor.edit(target, 'DIRTY ALPHA\n');
      assert.equal(await editor.open(target, { view: 'staged' }), true);
      assert.equal(editor.getSnapshot().comparisons[fileKey(target)].original, 'HEAD\n');
      assert.equal(await editor.open(target, { view: 'unstaged' }), true);
      assert.equal(editor.getSnapshot().comparisons[fileKey(target)].original, 'INDEX\n');
      await editor.open(other);
      editor.edit(other, 'DIRTY BETA\n');
      assert.equal(editor.getSnapshot().buffers.length, 2);
      assert.equal(await editor.save(target), true);
      await editor.flush();
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'DIRTY ALPHA\n');
      assert.equal(readFileSync(join(f.roots[1], 'a.ts'), 'utf8'), 'WORKING\n');
      await f.restart();
      const restored = await f.editor('comparison');
      assert.equal(restored.buffer(other)?.text, 'DIRTY BETA\n');
      assert.equal(restored.buffer(other)?.disk.text, 'WORKING\n');
      assert.equal(restored.getSnapshot().recovery.openCheckoutIds.length, 2);
      assert(
        Object.values(restored.getSnapshot().listings).filter((listing) =>
          listing.entries.some((entry) => entry.path === 'a.ts'),
        ).length >= 2,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "another controller's Save cannot rebase an independently persisted dirty baseline",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const a = await f.editor('actor-a'),
        b = await f.editor('actor-b');
      const checkout = await a.openCheckout(f.roots[0]);
      await b.openCheckout(f.roots[0]);
      const target = { checkout, path: 'a.ts' };
      await a.open(target);
      await b.open(target);
      a.edit(target, 'A SAVED\n');
      b.edit(target, 'B RETAINED\n');
      await a.flush();
      await b.flush();
      const baseline = b.buffer(target)!.disk;
      assert.equal(await a.save(target), true);
      assert.equal(await b.save(target), false);
      assert.deepEqual(b.buffer(target)?.disk, baseline);
      assert.equal(b.buffer(target)?.text, 'B RETAINED\n');
      await b.flush();
      assert.deepEqual(listDrafts(await f.loadRecovery('actor-b'))['a.ts'], {
        text: 'B RETAINED\n',
        disk: baseline,
      });
      await f.restart();
      const restored = await f.editor('actor-b');
      assert.deepEqual(restored.buffer(target)?.disk, baseline);
      assert.equal(await restored.save(target), false);
    } finally {
      await f.close();
    }
  },
);

test(
  'copy keeps both dirty drafts independently editable against actual copied disk',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const editor = await f.editor('copy'),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'b.ts' },
        copy = { checkout, path: 'copy.ts' };
      await editor.open(target);
      editor.edit(target, 'DIRTY SOURCE\n');
      const result = await editor.mutate({
        id: 'one-copy',
        checkout,
        kind: 'copy',
        sources: await editor.inspect(checkout, ['b.ts']),
        destination: 'copy.ts',
      });
      assert.equal(result.outcome, 'completed');
      assert.equal(editor.buffer(copy)?.text, 'DIRTY SOURCE\n');
      assert.equal(editor.buffer(copy)?.disk.text, 'B\n');
      assert.equal(editor.buffer(target)?.text, 'DIRTY SOURCE\n');
      assert.equal(await editor.save(copy), true);
      assert.equal(readFileSync(join(f.roots[0], 'copy.ts'), 'utf8'), 'DIRTY SOURCE\n');
      assert.equal(readFileSync(join(f.roots[0], 'b.ts'), 'utf8'), 'B\n');
    } finally {
      await f.close();
    }
  },
);

test(
  'SQLite contention fails a Discard close and keeps the draft, in memory and in the store',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let lock: DatabaseSync | undefined;
    try {
      const editor = await f.editor('blocked-close'),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'a.ts' };
      await editor.open(target);
      editor.edit(target, 'PRESERVE UNDER CONTENTION\n');
      await editor.flush();
      lock = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
      lock.exec('BEGIN IMMEDIATE');
      assert.equal(
        await answering(
          editor,
          () => editor.close([target]),
          async () => 'discard',
        ),
        false,
      );
      assert.equal(editor.buffer(target)?.text, 'PRESERVE UNDER CONTENTION\n');
      lock.exec('ROLLBACK');
      lock.close();
      lock = undefined;
      await editor.flush();
      assert.equal(editor.getSnapshot().recoveryFailed, false);
      assert.equal(editor.buffer(target)?.text, 'PRESERVE UNDER CONTENTION\n');
      assert.equal(
        listDrafts(await f.loadRecovery('blocked-close'))['a.ts']?.text,
        'PRESERVE UNDER CONTENTION\n',
      );
      assert.equal(
        await answering(
          editor,
          () => editor.close([target]),
          async () => 'cancel',
        ),
        false,
      );
      assert.equal(
        await answering(
          editor,
          () => editor.close([target]),
          async () => 'discard',
        ),
        true,
      );
      assert.equal(editor.buffer(target), undefined);
    } finally {
      if (lock) {
        lock.exec('ROLLBACK');
        lock.close();
      }
      await f.close();
    }
  },
);

test(
  'closed unavailable checkouts retain exact view metadata without discovery until authorized reopen',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let closedReads = 0,
      closedId = '';
    try {
      const editor = await f.editor('closed-root'),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'a.ts' };
      await editor.open(target, { view: 'staged' });
      editor.position(target, 'staged', { line: 1, column: 2, top: 3, left: 4 });
      editor.tree(checkout, { expanded: ['folder'], focus: 'folder/nested.ts' });
      await editor.flush();
      assert.equal(
        await answering(
          editor,
          () => editor.closeCheckout(checkout),
          async () => 'discard',
        ),
        true,
      );
      closedId = checkout.checkoutId;
      const restarted = await f.restart();
      renameSync(f.roots[0], f.roots[0] + '-unavailable');
      const observed: EditorClient = {
        ...restarted.client,
        command: async (operation, input, options) => {
          if (['readFile', 'readComparison', 'listDirectory', 'gitStatus'].includes(operation)) {
            const value = input as { checkout?: { checkoutId: string }; target?: FileTarget };
            if ((value.checkout ?? value.target?.checkout)?.checkoutId === closedId) closedReads++;
          }
          return restarted.client.command(operation, input, options);
        },
      };
      const restored = await f.editor('closed-root', observed);
      assert.equal(closedReads, 0);
      assert.equal(restored.getSnapshot().recovery.openCheckoutIds.length, 0);
      // A closed checkout's tabs close; what its view remembers of the files stays, by path.
      const view = restored.getSnapshot().recovery.views[checkout.checkoutId];
      assert.equal(view.fileViews['a.ts'], 'staged');
      assert.deepEqual(view.tree.expanded, ['folder']);
      renameSync(f.roots[0] + '-unavailable', f.roots[0]);
      assert.deepEqual(await restored.openCheckout(f.roots[0]), checkout);
      assert.equal(await restored.open(target), true);
      assert.equal(restored.buffer(target)?.text, 'WORKING\n');
      assert.equal(restored.getSnapshot().comparisons[fileKey(target)].original, 'HEAD\n');
      assert.deepEqual(
        restored.getSnapshot().recovery.views[checkout.checkoutId].positions['a.ts'].staged,
        { line: 1, column: 2, top: 3, left: 4 },
      );
      assert(closedReads > 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'a captured close retains a completed Save and defers every proposed Discard when a later Save conflicts',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const editor = await f.editor('captured-batch'),
        checkout = await editor.openCheckout(f.roots[0]);
      const a = { checkout, path: 'a.ts' },
        b = { checkout, path: 'b.ts' },
        c = { checkout, path: 'folder/nested.ts' };
      for (const target of [a, b, c]) {
        await editor.open(target);
        editor.edit(target, 'DIRTY ' + target.path + '\n');
      }
      await editor.flush();
      const baseline = editor.buffer(c)!.disk;
      writeFileSync(join(f.roots[0], c.path), 'EXTERNAL WRITER\n');
      assert.equal(
        await answering(
          editor,
          () => editor.close([a, b, c]),
          async (buffer) => (buffer.target.path === b.path ? 'discard' : 'save'),
        ),
        false,
      );
      assert.equal(readFileSync(join(f.roots[0], a.path), 'utf8'), 'DIRTY a.ts\n');
      assert.equal(editor.buffer(a)?.disk.text, 'DIRTY a.ts\n');
      assert.equal(editor.buffer(b)?.text, 'DIRTY b.ts\n');
      assert.equal(readFileSync(join(f.roots[0], b.path), 'utf8'), 'B\n');
      assert.equal(editor.buffer(c)?.text, 'DIRTY folder/nested.ts\n');
      assert.deepEqual(editor.buffer(c)?.disk, baseline);
      const durable = await f.loadRecovery('captured-batch');
      assert.equal(listDrafts(durable)[b.path]?.text, 'DIRTY b.ts\n');
      assert.deepEqual(listDrafts(durable)[c.path]?.disk, baseline);
      assert.equal(listTabs(durable, checkout.checkoutId).length, 3);
      assert.equal(
        await answering(
          editor,
          () => editor.prepareQuit(),
          async () => 'cancel',
        ),
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test('the editor publishes each Git change with its kind and an unmerged path once, as a conflict', async () => {
  const f = fixture();
  try {
    const root = f.roots[0];
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        [
          '-C',
          root,
          '-c',
          'user.name=Moonbase integration',
          '-c',
          'user.email=integration@example.invalid',
          ...args,
        ],
        { stdio: 'pipe' },
      );
    // Unstage a.ts so the merge may run; its edit does not touch the merged file.
    git('reset', '-q');
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'folder/nested.ts'), 'SIDE\n');
    git('add', 'folder/nested.ts');
    git('commit', '-qm', 'Side');
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'folder/nested.ts'), 'MAIN\n');
    git('add', 'folder/nested.ts');
    git('commit', '-qm', 'Main');
    assert.throws(() => git('merge', '-q', 'side'));
    git('add', 'a.ts');
    writeFileSync(join(root, 'a.ts'), 'WORKING AGAIN\n');
    rmSync(join(root, 'b.ts'));
    writeFileSync(join(root, 'new file.ts'), 'NEW\n');
    const editor = await f.editor('git-kinds'),
      checkout = await editor.openCheckout(root);
    await editor.refresh(checkout);
    const status = editor.getSnapshot().git[checkoutKey(checkout)];
    assert.equal(status.error, undefined);
    assert.deepEqual(
      [...status.changes].sort(
        (a, b) => a.path.localeCompare(b.path) || a.area.localeCompare(b.area),
      ),
      [
        { path: 'a.ts', area: 'staged', kind: 'modified' },
        { path: 'a.ts', area: 'unstaged', kind: 'modified' },
        { path: 'b.ts', area: 'unstaged', kind: 'deleted' },
        { path: 'folder/nested.ts', area: 'conflicted', kind: 'conflicted' },
        { path: 'new file.ts', area: 'untracked', kind: 'untracked' },
      ],
    );
  } finally {
    await f.close();
  }
});
