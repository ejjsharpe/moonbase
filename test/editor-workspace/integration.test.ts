import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { Effect, ManagedRuntime, Scope } from 'effect';
import {
  ApplicationError,
  type EditorClient,
  type FileTarget,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import {
  makeEditorModel,
  makeEditorController,
  checkoutKey,
  fileKey,
  type EditorController,
  type EditorBuffer,
  type CloseChoice,
} from '@moonbase/application/editor';
import { WorkspaceLocalLive, WorkspaceNative } from '@moonbase/workspace';

function answering<A>(
  controller: EditorController,
  action: () => Promise<A>,
  choose: (buffer: Readonly<EditorBuffer>) => Promise<CloseChoice>,
) {
  const answered = new Set<string>();
  const off = controller.subscribe(() => {
    const prompt = controller.getSnapshot().closePrompt;
    if (!prompt || answered.has(prompt.id)) return;
    answered.add(prompt.id);
    void choose(prompt.buffer).then((choice) => controller.answerClose(prompt.id, choice));
  });
  return action().finally(off);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-editor-fanin-')));
  const roots = [join(base, 'alpha'), join(base, 'beta')],
    dataDirectory = join(base, 'fresh-workspace');
  for (const root of roots) {
    mkdirSync(root);
    mkdirSync(join(root, 'folder'));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', [
        '-C',
        root,
        '-c',
        'user.name=Moonbase integration',
        '-c',
        'user.email=integration@example.invalid',
        ...args,
      ]);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'HEAD\n');
    writeFileSync(join(root, 'b.ts'), 'B\n');
    writeFileSync(join(root, 'folder/nested.ts'), 'NESTED\n');
    git('add', '.');
    git('commit', '-qm', 'Controlled initial files');
    writeFileSync(join(root, 'a.ts'), 'INDEX\n');
    git('add', 'a.ts');
    writeFileSync(join(root, 'a.ts'), 'WORKING\n');
  }
  const runtimes: ReturnType<typeof start>[] = [],
    editors: EditorController[] = [];
  function start() {
    const runtime = ManagedRuntime.make(
      WorkspaceLocalLive({
        hostId: 'fanin-local',
        installationId: 'fanin',
        dataDirectory,
        filesystemHelper: createRequire(import.meta.url).resolve('@moonbase/workspace/filesystem'),
        ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP ?? resolve('dist/tools/ripgrep/rg'),
      }),
    );
    return { runtime, client: makeEditorClient(runtime) };
  }
  const launch = () => {
    const value = start();
    runtimes.push(value);
    return value;
  };
  const current = launch();
  async function editor(clientId: string, client = current.client) {
    const runtime = runtimes.at(-1)!.runtime;
    const model = await runtime.runPromise(
      makeEditorModel({ client, clientId }).pipe(Effect.provideService(Scope.Scope, runtime.scope)),
    );
    const value = makeEditorController(runtime, model);
    editors.push(value);
    await value.load();
    return value;
  }
  return {
    ...current,
    base,
    roots,
    dataDirectory,
    editor,
    launch,
    async close() {
      for (const value of editors) await value.dispose();
      for (const value of runtimes) await value.runtime.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
const code = (expected: ApplicationError['code']) => (error: unknown) =>
  ApplicationError.is(error) && error.code === expected;

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
      const workflow = editor.createMutation({ checkout, kind, paths: [source, 'folder'] });
      try {
        assert.equal(await workflow.apply('dest', '', false), !collision);
        assert.equal(workflow.getSnapshot().error, '');
        assert.deepEqual(
          workflow.getSnapshot().replacements?.map((entry) => entry.target.path),
          collision ? ['dest/' + collision] : [],
        );
        if (collision) {
          assert.equal(readFileSync(join(f.roots[0], 'dest', collision), 'utf8'), 'REPLACE\n');
          assert.equal(await workflow.apply('dest', '', true), true, workflow.getSnapshot().error);
        }
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
      } finally {
        await workflow.dispose();
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
      const workflow = editor.createMutation({ checkout, kind, paths: ['b.ts', 'folder'] });
      try {
        assert.equal(await workflow.apply('dest', '', false), false);
        assert.equal(await workflow.apply('dest', '', true), false);
        assert.match(workflow.getSnapshot().error, /Replacement has open buffers/);
        assert.equal(editor.buffer(target)?.text, 'UNSAVED\n');
        assert.equal(readFileSync(join(f.roots[0], target.path), 'utf8'), 'RETAIN\n');
      } finally {
        await workflow.dispose();
      }
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
        Effect.flatMap(WorkspaceNative, (native) =>
          native.capture({ checkout, clientId: editor.clientId, paths }),
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
      await editor.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor('comparison', restarted.client);
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
  'an admitted Save reply preserves newer live text and its original saved baseline across restart',
  { timeout: 30000 },
  async () => {
    const f = fixture(),
      admitted = deferred(),
      reply = deferred();
    let saves = 0;
    const gated: EditorClient = {
      watch: f.client.watch,
      command: async (operation, input, options) => {
        const result = await f.client.command(operation, input, options);
        if (operation === 'saveFile') {
          saves++;
          admitted.resolve();
          await reply.promise;
        }
        return result;
      },
    };
    try {
      const editor = await f.editor('save-handoff', gated),
        checkout = await editor.openCheckout(f.roots[0]);
      const target = { checkout, path: 'a.ts' };
      await editor.open(target);
      editor.edit(target, 'CAPTURED SAVE\n');
      await editor.flush();
      const saving = editor.save(target);
      await admitted.promise;
      editor.edit(target, 'NEWER LIVE TEXT\n');
      reply.resolve();
      assert.equal(await saving, false);
      assert.equal(saves, 1);
      await editor.flush();
      assert.equal(editor.buffer(target)?.text, 'NEWER LIVE TEXT\n');
      assert.equal(editor.buffer(target)?.disk.text, 'CAPTURED SAVE\n');
      await editor.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor('save-handoff', restarted.client);
      assert.equal(restored.buffer(target)?.text, 'NEWER LIVE TEXT\n');
      assert.equal(restored.buffer(target)?.disk.text, 'CAPTURED SAVE\n');
      assert.equal(readFileSync(join(f.roots[0], 'a.ts'), 'utf8'), 'CAPTURED SAVE\n');
    } finally {
      reply.resolve();
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
      const durable = await f.client.command('loadRecovery', { clientId: 'actor-b' });
      assert.deepEqual(durable.state.drafts[0].disk, baseline);
      assert.equal(durable.state.drafts[0].text, 'B RETAINED\n');
      await a.dispose();
      await b.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor('actor-b', restarted.client);
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
  'actual SQLite contention vetoes discard; resolving a preflight cannot silently commit Close',
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
      assert.equal(await editor.resolveRecoveryPublication(), true);
      assert.equal(editor.buffer(target)?.text, 'PRESERVE UNDER CONTENTION\n');
      assert.equal(
        (await f.client.command('loadRecovery', { clientId: 'blocked-close' })).state.drafts[0]
          .text,
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
  'lost final Close response resolves its original SQLite receipt without adopting a later revision',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let unknown = true,
      finalCommits = 0;
    const transport: EditorClient = {
      watch: f.client.watch,
      command: async (operation, input, options) => {
        if (operation === 'getRecoveryPublication' && unknown)
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Controlled receipt response loss',
          });
        const result = await f.client.command(operation, input, options);
        if (
          operation === 'persistRecovery' &&
          !(input as { state: { drafts: unknown[] } }).state.drafts.length &&
          unknown
        ) {
          finalCommits++;
          throw new ApplicationError({
            code: 'Uncertain',
            message: 'Controlled committed response loss',
          });
        }
        return result;
      },
    };
    try {
      // Start losing only the final publication after the draft is durably present.
      unknown = false;
      const editor = await f.editor('unknown-close', transport),
        checkout = await editor.openCheckout(f.roots[0]),
        target = { checkout, path: 'a.ts' };
      await editor.open(target);
      editor.edit(target, 'DISCARD ONLY ON EXACT RECEIPT\n');
      await editor.flush();
      unknown = true;
      assert.equal(
        await answering(
          editor,
          () => editor.close([target]),
          async () => 'discard',
        ),
        false,
      );
      assert.equal(finalCommits, 1);
      assert.equal(editor.buffer(target)?.text, 'DISCARD ONLY ON EXACT RECEIPT\n');
      assert.equal(editor.getSnapshot().publication?.kind, 'close');
      const committed = await f.client.command('loadRecovery', { clientId: 'unknown-close' });
      assert.equal(committed.state.drafts.length, 0);
      await f.client.command('persistRecovery', {
        clientId: 'unknown-close',
        requestId: randomUUID(),
        expectedRevision: committed.revision,
        state: { ...committed.state, sidebarWidth: 321 },
      });
      unknown = false;
      assert.equal(await editor.resolveRecoveryPublication(), true);
      assert.equal(editor.buffer(target), undefined);
      await assert.rejects(editor.flush(), code('Conflict'));
      assert.equal(finalCommits, 1);
      await editor.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor('unknown-close', restarted.client);
      assert.equal(restored.buffer(target), undefined);
      assert.equal(restored.getSnapshot().recovery.sidebarWidth, 321);
    } finally {
      unknown = false;
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
      await editor.dispose();
      await f.runtime.dispose();
      renameSync(f.roots[0], f.roots[0] + '-unavailable');
      const restarted = f.launch();
      const observed: EditorClient = {
        watch: restarted.client.watch,
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
      const view = restored.getSnapshot().recovery.views[checkout.checkoutId];
      assert.equal(view.active, 'a.ts');
      assert.equal(view.fileViews['a.ts'], 'staged');
      assert.deepEqual(view.tree.expanded, ['folder']);
      renameSync(f.roots[0] + '-unavailable', f.roots[0]);
      assert.deepEqual(await restored.openCheckout(f.roots[0]), checkout);
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
      const durable = await f.client.command('loadRecovery', { clientId: 'captured-batch' });
      assert.equal(
        durable.state.drafts.find((draft) => draft.target.path === b.path)?.text,
        'DIRTY b.ts\n',
      );
      assert.deepEqual(
        durable.state.drafts.find((draft) => draft.target.path === c.path)?.disk,
        baseline,
      );
      assert.equal(durable.state.views[checkout.checkoutId].openFiles.length, 3);
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

test(
  'a lost Save reply recovers every own transition without another native replacement',
  { timeout: 15000 },
  async () => {
    const f = fixture();
    let lose = true;
    const requestIds = new Map<string, Set<string>>();
    const transport: EditorClient = {
      watch: f.client.watch,
      command: async (operation, input, options) => {
        const result = await f.client.command(operation, input, options);
        if (operation === 'saveFile') {
          const request = input as { target: FileTarget; requestId: string };
          const ids = requestIds.get(request.target.path) ?? new Set<string>();
          ids.add(request.requestId);
          requestIds.set(request.target.path, ids);
          if (request.target.path === 'a.ts') {
            if (lose) {
              lose = false;
              throw new ApplicationError({
                code: 'Uncertain',
                message: 'Controlled committed Save reply loss',
              });
            }
          }
        }
        return result;
      },
    };
    try {
      const editor = await f.editor('two-saves', transport),
        checkout = await editor.openCheckout(f.roots[0]);
      const a = { checkout, path: 'a.ts' },
        b = { checkout, path: 'b.ts' };
      for (const target of [a, b]) {
        await editor.open(target);
        editor.edit(target, 'CAPTURED ' + target.path);
      }
      await editor.flush();
      const first = editor.save(a).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      assert('error' in (await first));
      const inodeA = statSync(join(f.roots[0], a.path)).ino;
      await editor.save(b).catch(() => false);
      const inodeB = statSync(join(f.roots[0], b.path)).ino;
      editor.edit(a, 'NEWER A AFTER CAPTURE');
      editor.edit(b, 'NEWER B AFTER CAPTURE');
      await editor.save(a).catch(() => false);
      await editor.flush();
      assert.equal(
        statSync(join(f.roots[0], a.path)).ino,
        inodeA,
        'Recovering the original Save receipt must not replace disk again',
      );
      assert.equal(statSync(join(f.roots[0], b.path)).ino, inodeB);
      assert.equal(requestIds.get(a.path)?.size, 1);
      assert.equal(requestIds.get(b.path)?.size, 1);
      assert.equal(readFileSync(join(f.roots[0], a.path), 'utf8'), 'CAPTURED a.ts');
      assert.equal(readFileSync(join(f.roots[0], b.path), 'utf8'), 'CAPTURED b.ts');
      assert.equal(
        await answering(
          editor,
          () => editor.prepareQuit(),
          async () => 'cancel',
        ),
        false,
      );
      await editor.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor('two-saves', restarted.client);
      assert.equal(restored.buffer(a)?.text, 'NEWER A AFTER CAPTURE');
      assert.equal(restored.buffer(a)?.disk.text, 'CAPTURED a.ts');
      assert.equal(restored.buffer(b)?.text, 'NEWER B AFTER CAPTURE');
      assert.equal(restored.buffer(b)?.disk.text, 'CAPTURED b.ts');
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      lose = false;
      await f.close();
    }
  },
);

test(
  'a publication whose reply is lost with an already-started Save resolves without losing newer drafts',
  { timeout: 15000 },
  async () => {
    const f = fixture(),
      startedB = deferred(),
      releaseB = deferred();
    let holdB = true,
      failPublication = false,
      denyStatus = false,
      saveCalls = 0;
    let original: Parameters<EditorClient['command']>[1] | undefined,
      originalId = '',
      rejectedOriginal = false;
    const transport: EditorClient = {
      watch: f.client.watch,
      command: async (operation, input, options) => {
        if (operation === 'saveFile') {
          saveCalls++;
          if ((input as { target: FileTarget }).target.path === 'b.ts' && holdB) {
            startedB.resolve();
            await releaseB.promise;
          }
        }
        if (operation === 'getRecoveryPublication' && denyStatus)
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Controlled unavailable publication status',
          });
        if (operation === 'persistRecovery') {
          const publication = input as { requestId: string };
          if (publication.requestId === originalId)
            assert.deepEqual(
              input,
              original,
              'An exact publication retry cannot change its captured input',
            );
          if (failPublication) {
            failPublication = false;
            original = structuredClone(input);
            originalId = publication.requestId;
            await f.client.command(operation, input, options);
            denyStatus = true;
            throw new ApplicationError({
              code: 'Unavailable',
              message: 'Controlled committed publication response failure',
            });
          }
        }
        try {
          return await f.client.command(operation, input, options);
        } catch (error) {
          if (
            operation === 'persistRecovery' &&
            (input as { requestId: string }).requestId === originalId &&
            ApplicationError.is(error) &&
            error.code === 'Conflict'
          )
            rejectedOriginal = true;
          throw error;
        }
      },
    };
    try {
      const editor = await f.editor('publication-lost', transport),
        checkout = await editor.openCheckout(f.roots[0]);
      const a = { checkout, path: 'a.ts' },
        b = { checkout, path: 'b.ts' };
      for (const target of [a, b]) {
        await editor.open(target);
        editor.edit(target, 'CAPTURE ' + target.path);
      }
      await editor.flush();
      const savingB = editor.save(b).catch(() => false);
      await startedB.promise;
      failPublication = true;
      await editor.save(a).catch(() => false);
      const inodeA = statSync(join(f.roots[0], a.path)).ino;
      const firstReceipt = await f.client.command('getRecoveryPublication', {
        clientId: editor.clientId,
        requestId: originalId,
      });
      holdB = false;
      releaseB.resolve();
      await savingB;
      const inodeB = statSync(join(f.roots[0], b.path)).ino;
      editor.edit(a, 'NEWER A DURING PUBLICATION');
      editor.edit(b, 'NEWER B DURING PUBLICATION');
      denyStatus = false;
      await editor.resolveRecoveryPublication();
      // Explicit retries of already-known Save facts must not dispatch another Save.
      if (editor.buffer(a)?.pendingSave) await editor.save(a).catch(() => false);
      if (editor.buffer(b)?.pendingSave) await editor.save(b).catch(() => false);
      await editor.flush();
      const retained = await f.client.command('getRecoveryPublication', {
        clientId: editor.clientId,
        requestId: originalId,
      });
      if (rejectedOriginal) assert.equal(retained, null);
      else assert.deepEqual(retained, firstReceipt);
      assert.equal(saveCalls, 2);
      assert.equal(statSync(join(f.roots[0], a.path)).ino, inodeA);
      assert.equal(statSync(join(f.roots[0], b.path)).ino, inodeB);
      const durable = await f.client.command('loadRecovery', { clientId: editor.clientId });
      assert.equal(
        durable.state.drafts.find((draft) => draft.target.path === a.path)?.text,
        'NEWER A DURING PUBLICATION',
      );
      assert.equal(
        durable.state.drafts.find((draft) => draft.target.path === b.path)?.text,
        'NEWER B DURING PUBLICATION',
      );
      assert.equal(
        await answering(
          editor,
          () => editor.prepareQuit(),
          async () => 'cancel',
        ),
        false,
      );
      await editor.dispose();
      await f.runtime.dispose();
      const restarted = f.launch(),
        restored = await f.editor(editor.clientId, restarted.client);
      assert.equal(restored.buffer(a)?.text, 'NEWER A DURING PUBLICATION');
      assert.equal(restored.buffer(a)?.disk.text, 'CAPTURE a.ts');
      assert.equal(restored.buffer(b)?.text, 'NEWER B DURING PUBLICATION');
      assert.equal(restored.buffer(b)?.disk.text, 'CAPTURE b.ts');
      assert.equal(
        await answering(
          restored,
          () => restored.prepareQuit(),
          async () => 'discard',
        ),
        true,
      );
    } finally {
      holdB = false;
      denyStatus = false;
      releaseB.resolve();
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
