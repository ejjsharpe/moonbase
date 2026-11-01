import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, renameSync, symlinkSync, linkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime, Effect } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { ApplicationError, emptyRecovery, type CheckoutTarget, type EditorRecovery } from '@moonbase/application/client';
import { WorkspaceLive, WorkspaceNative } from '../src/index.ts';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-workspace-'))), root = join(base, 'repo'), dataDirectory = join(base, 'state');
  mkdirSync(root); execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  const start = () => {
    const runtime = ManagedRuntime.make(WorkspaceLive({dataDirectory, hostId: 'local-test', ...(process.env.MOONBASE_TEST_RIPGREP ? {ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP} : {})}));
    return {runtime, client: makeEditorClient(runtime)};
  };
  const instance = start();
  return {...instance, base, root, dataDirectory, start, async close() { await instance.runtime.dispose(); rmSync(base, {recursive: true, force: true}); }};
}
const rejects = (code: ApplicationError['code']) => (error: unknown) => error instanceof ApplicationError && error.code === code;
function draft(clientId: string, checkout: CheckoutTarget, text: string, disk: {text: string; version: string}): EditorRecovery {
  return {...emptyRecovery(clientId), checkouts: [checkout], selectedCheckoutId: checkout.checkoutId, drafts: [{target: {checkout, path: 'file.txt'}, text, disk}]};
}

test('public client saves, rejects changed retries and preserves original dirty conflict baselines across restart', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'original');
    const checkout = await f.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'};
    const disk = await f.client.command('readFile', target);
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: draft('alice', checkout, 'dirty text', disk)});
    writeFileSync(join(f.root, 'file.txt'), 'external');
    const input = {target, clientId: 'alice', requestId: 'save-1', text: 'dirty text', expectedVersion: disk.version};
    const conflict = await f.client.command('saveFile', input);
    assert.equal(conflict.kind, 'conflict');
    assert.equal((await f.client.command('loadRecovery', {clientId: 'alice'})).state.drafts[0].disk.text, 'original');
    await assert.rejects(f.client.command('saveFile', {...input, text: 'changed retry'}), rejects('Conflict'));
    assert.deepEqual(await f.client.command('saveFile', input), conflict);
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'external');
    assert.equal((await f.client.command('saveFile', {...input, requestId: 'deliberate-overwrite', expectedVersion: conflict.disk.version})).kind, 'saved');
    await f.runtime.dispose();
    const restarted = f.start();
    try {
      const state = await restarted.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(state.state.drafts[0].text, 'dirty text');
      assert.equal(state.state.drafts[0].disk.text, 'original');
      assert.equal((await restarted.client.command('readFile', target)).text, 'dirty text');
      assert.deepEqual(await restarted.client.command('saveFile', input), conflict);
    } finally { await restarted.runtime.dispose(); }
  } finally { await f.close(); }
});

test('independent clients and compare-and-swap recovery do not overwrite one another; invalid baselines fail', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', {root: f.root}), disk = await f.client.command('readFile', {checkout, path: 'file.txt'});
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: draft('alice', checkout, 'alice edit', disk)});
    await f.client.command('persistRecovery', {clientId: 'bob', expectedRevision: 0, state: draft('bob', checkout, 'bob edit', disk)});
    await assert.rejects(f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: emptyRecovery('alice')}), rejects('Conflict'));
    assert.equal((await f.client.command('loadRecovery', {clientId: 'bob'})).state.drafts[0].text, 'bob edit');
    const bad = draft('alice', checkout, 'safe', {...disk, version: 'wrong'});
    await assert.rejects(f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: bad}), rejects('InvalidInput'));
  } finally { await f.close(); }
});

test('known move preserves drafts and exact target, acknowledgement requires recovery publication; replay does not move twice', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', {root: f.root}), disk = await f.client.command('readFile', {checkout, path: 'file.txt'});
    const state = draft('alice', checkout, 'dirty', disk);
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state});
    const sources = await f.client.command('inspectEntries', {checkout, paths: ['file.txt']});
    const operation = {id: 'move-1', clientId: 'alice', checkout, kind: 'move' as const, sources, destination: 'renamed.txt'};
    const result = await f.client.command('mutate', operation);
    assert.equal(result.outcome, 'completed'); assert.deepEqual(result.checkout, checkout);
    await assert.rejects(f.client.command('acknowledgeOperation', {clientId: 'alice', id: 'move-1'}), rejects('Persistence'));
    const recovered = await f.client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(recovered.state.drafts[0].target.path, 'renamed.txt'); assert.deepEqual(recovered.state.drafts[0].disk, disk);
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: recovered.revision, state: recovered.state});
    await f.client.command('acknowledgeOperation', {clientId: 'alice', id: 'move-1'});
    assert.deepEqual(await f.client.command('mutate', operation), result);
    await assert.rejects(f.client.command('mutate', {...operation, destination: 'other.txt'}), rejects('Conflict'));
    await f.runtime.dispose(); const restarted = f.start();
    try { assert.deepEqual(await restarted.client.command('operationStatus', {clientId: 'alice', id: 'move-1'}), result); assert.equal((await restarted.client.command('loadRecovery', {clientId: 'alice'})).state.drafts[0].target.path, 'renamed.txt'); }
    finally { await restarted.runtime.dispose(); }
  } finally { await f.close(); }
});

test('local/remote and root replacement identities, traversal, symlinks, binary, size and hard-link save boundaries reject', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk'); writeFileSync(join(f.base, 'secret'), 'secret'); symlinkSync(join(f.base, 'secret'), join(f.root, 'link'));
    writeFileSync(join(f.root, 'binary'), Buffer.from([0, 12])); writeFileSync(join(f.root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const checkout = await f.client.command('openCheckout', {root: f.root});
    for (const p of ['../secret', '.git/config', 'a/../file.txt', '/file.txt', 'link', 'binary', 'large']) await assert.rejects(f.client.command('readFile', {checkout, path: p}));
    await assert.rejects(f.client.command('readFile', {checkout: {...checkout, hostId: 'remote'}, path: 'file.txt'}), rejects('Unauthorized'));
    const disk = await f.client.command('readFile', {checkout, path: 'file.txt'}); linkSync(join(f.root, 'file.txt'), join(f.root, 'hard-link'));
    await assert.rejects(f.client.command('saveFile', {target: {checkout, path: 'file.txt'}, clientId: 'a', requestId: 'hard', text: 'new', expectedVersion: disk.version}));
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'disk');
    renameSync(f.root, f.root + '-old'); mkdirSync(f.root); writeFileSync(join(f.root, 'file.txt'), 'wrong checkout');
    await assert.rejects(f.client.command('readFile', {checkout, path: 'file.txt'}));
  } finally { await f.close(); }
});

test('Git staged and unstaged originals both compare against the current working document, lookup and ignore filtering work', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'HEAD');
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
    git(['add', '.']); git(['commit', '-qm', 'initial']);
    writeFileSync(join(f.root, 'file.txt'), 'index'); git(['add', '.']); writeFileSync(join(f.root, 'file.txt'), 'working');
    writeFileSync(join(f.root, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(f.root, 'ignored.txt'), 'ignored');
    const checkout = await f.client.command('openCheckout', {root: f.root});
    const staged = await f.client.command('readComparison', {target: {checkout, path: 'file.txt'}, area: 'staged'}), unstaged = await f.client.command('readComparison', {target: {checkout, path: 'file.txt'}, area: 'unstaged'});
    assert.equal(staged.original, 'HEAD'); assert.equal(unstaged.original, 'index'); assert.equal(staged.working?.text, 'working');
    assert.deepEqual((await f.client.command('gitStatus', {checkout})).changes.filter(c => c.path === 'file.txt').map(c => c.area), ['staged', 'unstaged']);
    assert((await f.client.command('lookupFiles', {checkout, query: 'fltx'})).paths.includes('file.txt'));
    assert(!(await f.client.command('listDirectory', {checkout, path: '', hideIgnored: true})).entries.some(e => e.path === 'ignored.txt'));
  } finally { await f.close(); }
});

test('watch notifies external changes, coalesces and disposes independently of file commands', async () => {
  const f = fixture(); let stop = () => {};
  try {
    writeFileSync(join(f.root, 'file.txt'), 'before'); const checkout = await f.client.command('openCheckout', {root: f.root});
    let ready!: () => void, changed!: () => void, count = 0;
    const readyPromise = new Promise<void>(r => ready = r), changedPromise = new Promise<void>(r => changed = r);
    stop = f.client.watch({checkout, paths: ['']}, event => { count++; if (event.ready) ready(); else changed(); }, error => { throw error; });
    await readyPromise; writeFileSync(join(f.root, 'file.txt'), 'external');
    await Promise.race([changedPromise, new Promise((_, reject) => setTimeout(() => reject(Error('watch timeout')), 2000))]);
    stop(); await f.runtime.runPromise(Effect.yieldNow); const before = count;
    writeFileSync(join(f.root, 'file.txt'), 'after disposal'); await new Promise(r => setTimeout(r, 250));
    assert.equal(count, before); assert.equal((await f.client.command('readFile', {checkout, path: 'file.txt'})).text, 'after disposal');
  } finally { stop(); await f.close(); }
});

test('create/copy and scoped native import use actual files; single-use references cannot authorize a later operation', async () => {
  const f = fixture();
  try {
    const checkout = await f.client.command('openCheckout', {root: f.root});
    const publish = async (id: string) => { const current = await f.client.command('loadRecovery', {clientId: 'alice'}); await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: current.revision, state: current.state}); await f.client.command('acknowledgeOperation', {clientId: 'alice', id}); };
    assert.equal((await f.client.command('mutate', {id: 'create', clientId: 'alice', checkout, kind: 'create-file', sources: [], destination: 'created.txt', text: 'created'})).outcome, 'completed'); await publish('create');
    const sources = await f.client.command('inspectEntries', {checkout, paths: ['created.txt']});
    assert.equal((await f.client.command('mutate', {id: 'copy', clientId: 'alice', checkout, kind: 'copy', sources, destination: 'copy.txt'})).outcome, 'completed'); await publish('copy');
    assert.equal(readFileSync(join(f.root, 'copy.txt'), 'utf8'), 'created');
    writeFileSync(join(f.base, 'external.txt'), 'native bytes');
    const references = await f.runtime.runPromise(Effect.flatMap(WorkspaceNative, native => native.capture({checkout, clientId: 'alice', paths: [join(f.base, 'external.txt')]})));
    assert.equal((await f.client.command('mutate', {id: 'import', clientId: 'alice', checkout, kind: 'import', sources: [], nativeReferences: references, destination: 'imported.txt'})).outcome, 'completed'); await publish('import');
    assert.equal(readFileSync(join(f.root, 'imported.txt'), 'utf8'), 'native bytes');
    await assert.rejects(f.client.command('mutate', {id: 'import-again', clientId: 'alice', checkout, kind: 'import', sources: [], nativeReferences: references, destination: 'again.txt'}), rejects('Unauthorized'));
  } finally { await f.close(); }
});

test('identical source paths in independent checkout identities never reconcile each other, including restart', async () => {
  const f = fixture();
  try {
    const root2 = join(f.base, 'repo2'); mkdirSync(root2); execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root2]);
    for (const root of [f.root, root2]) writeFileSync(join(root, 'file.txt'), 'disk');
    const a = await f.client.command('openCheckout', {root: f.root}), b = await f.client.command('openCheckout', {root: root2});
    const disk = await f.client.command('readFile', {checkout: a, path: 'file.txt'});
    const state = draft('alice', a, 'first', disk); state.checkouts.push(b); state.drafts.push({target: {checkout: b, path: 'file.txt'}, text: 'second', disk});
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state});
    const sources = await f.client.command('inspectEntries', {checkout: a, paths: ['file.txt']});
    const result = await f.client.command('mutate', {id: 'move', clientId: 'alice', checkout: a, kind: 'move', sources, destination: 'moved.txt'});
    assert.deepEqual(result.checkout, a);
    await f.runtime.dispose(); const restarted = f.start();
    try {
      const restored = await restarted.client.command('loadRecovery', {clientId: 'alice'});
      assert.deepEqual(restored.state.drafts.map(d => [d.target.checkout.checkoutId, d.target.path, d.text]), [[a.checkoutId, 'moved.txt', 'first'], [b.checkoutId, 'file.txt', 'second']]);
      assert.deepEqual(restored.operations[0].checkout, a);
    } finally { await restarted.runtime.dispose(); }
  } finally { await f.close(); }
});

test('real SQLite write contention vetoes recovery discard and mutation before any filesystem change', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk'); const checkout = await f.client.command('openCheckout', {root: f.root});
    const disk = await f.client.command('readFile', {checkout, path: 'file.txt'});
    await f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: draft('alice', checkout, 'retained', disk)});
    const lock = new DatabaseSync(join(f.dataDirectory, 'moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(f.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: emptyRecovery('alice')}), rejects('Persistence'));
      const sources = await f.client.command('inspectEntries', {checkout, paths: ['file.txt']});
      await assert.rejects(f.client.command('mutate', {id: 'vetoed', clientId: 'alice', checkout, kind: 'move', sources, destination: 'moved.txt'}));
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'disk');
      assert.equal((await f.client.command('loadRecovery', {clientId: 'alice'})).state.drafts[0].text, 'retained');
    } finally { lock.exec('ROLLBACK'); lock.close(); }
  } finally { await f.close(); }
});

for (const kind of ['move', 'trash'] as const) test(`lost native ${kind} response preserves drafts and restart never repeats the mutation`, async () => {
  const f = fixture();
  const {fileURLToPath} = await import('node:url');
  const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
  const helper = join(f.base, 'lose-response'), countFile = join(f.base, 'count'), receipt = join(f.base, 'trash-receipt');
  // Only this controlled helper drops a response after calling the actual production native binary.
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(helper, `#!/bin/sh\nif [ "$1" = ${quote(kind)} ]; then\n  printf 'called\\n' >> ${quote(countFile)}\n  ${quote(binary)} "$@" > ${quote(receipt)}\n  status=$?\n  if [ "$status" -ne 0 ]; then exit "$status"; fi\n  kill -KILL $$\nfi\nexec ${quote(binary)} "$@"\n`); chmodSync(helper, 0o700);
  const runtime = ManagedRuntime.make(WorkspaceLive({dataDirectory: f.dataDirectory, hostId: 'local-test', filesystemHelper: helper})), client = makeEditorClient(runtime);
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk bytes');
    const checkout = await client.command('openCheckout', {root: f.root}), disk = await client.command('readFile', {checkout, path: 'file.txt'});
    await client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: draft('alice', checkout, 'dirty survives', disk)});
    const sources = await client.command('inspectEntries', {checkout, paths: ['file.txt']});
    const operation = {id: 'lost', clientId: 'alice', checkout, kind, sources, ...(kind === 'move' ? {destination: 'moved.txt'} : {})};
    const result = await client.command('mutate', operation);
    assert.equal(result.outcome, 'uncertain'); assert.deepEqual(result.checkout, checkout);
    assert.equal(readFileSync(countFile, 'utf8'), 'called\n');
    await runtime.dispose(); const restarted = f.start();
    try {
      const recovered = await restarted.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(recovered.state.drafts[0].text, 'dirty survives'); assert.deepEqual(recovered.state.drafts[0].disk, disk);
      assert.equal(recovered.state.drafts[0].target.path, kind === 'move' ? 'moved.txt' : 'file.txt');
      assert.equal(recovered.operations[0].outcome, kind === 'move' ? 'completed' : 'uncertain');
      if (kind === 'trash') {
        assert(recovered.errors.some(e => e.includes('Uncertain')));
        await assert.rejects(restarted.client.command('acknowledgeOperation', {clientId: 'alice', id: 'lost'}));
      }
      await restarted.client.command('mutate', operation);
      assert.equal(readFileSync(countFile, 'utf8'), 'called\n');
    } finally { await restarted.runtime.dispose(); }
  } finally {
    await runtime.dispose();
    if (kind === 'trash' && existsSync(receipt)) {
      const trashed = readFileSync(receipt, 'utf8');
      if (trashed.includes('/.Trash/') && existsSync(trashed)) { assert.equal(readFileSync(trashed, 'utf8'), 'disk bytes'); rmSync(trashed); }
    }
    await f.close();
  }
});

test('known native Trash keeps another client draft and deliberate replacement uses captured identities', async () => {
  const f = fixture(); let trashPath = '';
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const checkout = await f.client.command('openCheckout', {root: f.root}), disk = await f.client.command('readFile', {checkout, path: 'file.txt'});
    await f.client.command('persistRecovery', {clientId: 'bob', expectedRevision: 0, state: draft('bob', checkout, 'bob survives trash', disk)});
    const sources = await f.client.command('inspectEntries', {checkout, paths: ['file.txt']});
    const result = await f.client.command('mutate', {id: 'trash', clientId: 'alice', checkout, kind: 'trash', sources});
    assert.equal(result.outcome, 'completed'); assert(!existsSync(join(f.root, 'file.txt')));
    trashPath = result.items[0].message!.replace('macOS Trash: ', '');
    assert.equal((await f.client.command('loadRecovery', {clientId: 'bob'})).state.drafts[0].text, 'bob survives trash');
  } finally { if (trashPath.includes('/.Trash/') && existsSync(trashPath)) rmSync(trashPath); await f.close(); }
});
