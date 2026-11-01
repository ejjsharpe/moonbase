import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, ManagedRuntime } from 'effect';
import { ApplicationError, emptyRecovery, type CheckoutTarget, type EditorRecovery } from '@moonbase/application/client';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { WorkspaceLive, WorkspaceNative } from '../src/index.ts';
const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-review-'))), root = join(base, 'repo'), dataDirectory = join(base, 'state');
  mkdirSync(root); execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]); writeFileSync(join(root, 'file.txt'), 'original');
  const start = (filesystemHelper = binary) => {
    const runtime = ManagedRuntime.make(WorkspaceLive({dataDirectory, hostId: 'review-host', filesystemHelper}));
    return {runtime, client: makeEditorClient(runtime)};
  };
  const wrapper = (body: string) => { const path = join(base, 'helper-' + Math.random()); writeFileSync(path, '#!/bin/sh\n' + body + '\nexec ' + quote(binary) + ' "$@"\n'); chmodSync(path, 0o700); return path; };
  return {base, root, start, wrapper, cleanup: () => rmSync(base, {recursive: true, force: true})};
}
const isError = (code: ApplicationError['code']) => (value: unknown) => ApplicationError.is(value) && value.code === code;
function state(checkout: CheckoutTarget, disk: {text: string; version: string}, text = 'older draft'): EditorRecovery {
  return {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts: [{target: {checkout, path: 'file.txt'}, disk, text}]};
}
async function waitFor(path: string) { const deadline = Date.now() + 3000; while (!existsSync(path)) { assert(Date.now() < deadline, 'native helper did not reach barrier'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('R1 aliases cannot authorize two same-baseline saves of one macOS object', async () => {
  const f = fixture(), {runtime, client} = f.start();
  try {
    assert(existsSync(join(f.root, 'FILE.TXT')), 'This regression requires the case-insensitive macOS fixture volume.');
    const checkout = await client.command('openCheckout', {root: f.root}), disk = await client.command('readFile', {checkout, path: 'file.txt'});
    const results = await Promise.allSettled(['file.txt', 'FILE.TXT'].map((path, i) => client.command('saveFile', {target: {checkout, path}, clientId: 'alice', requestId: 'alias-' + i, text: 'save-' + i, expectedVersion: disk.version})));
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.kind === 'saved').length, 1);
    assert.equal(results[1].status, 'rejected');
    await assert.rejects(client.command('readFile', {checkout, path: 'FILE.TXT'}), isError('InvalidInput'));
    const sources = await client.command('inspectEntries', {checkout, paths: ['file.txt']});
    assert.equal((await client.command('mutate', {clientId: 'alice', id: 'case-only', checkout, kind: 'move', sources, destination: 'FILE.TXT'})).outcome, 'completed');
    assert.equal((await client.command('readFile', {checkout, path: 'FILE.TXT'})).text, 'save-0');
  } finally { await runtime.dispose(); f.cleanup(); }
});

for (const selection of ['self', 'descendant', 'ancestor'] as const) test(`R2 native ${selection} import rejects before replacement Trash`, async () => {
  const f = fixture(), count = join(f.base, 'trash-count');
  const helper = f.wrapper(`if [ "$1" = trash ]; then printf 'trash\\n' >> ${quote(count)}; exit 1; fi`), {runtime, client} = f.start(helper);
  try {
    if (selection !== 'self') { mkdirSync(join(f.root, 'source')); writeFileSync(join(f.root, 'source/child'), 'keep child'); }
    const checkout = await client.command('openCheckout', {root: f.root}), source = selection === 'descendant' ? 'source' : selection === 'ancestor' ? 'source/child' : 'file.txt', destination = selection === 'descendant' ? 'source/child' : selection === 'ancestor' ? 'source' : source;
    const nativeReferences = await runtime.runPromise(Effect.flatMap(WorkspaceNative, native => native.capture({checkout, clientId: 'alice', paths: [join(f.root, source)]})));
    const replacements = await client.command('inspectEntries', {checkout, paths: [destination]});
    await assert.rejects(client.command('mutate', {id: 'self-import', clientId: 'alice', checkout, kind: 'import', sources: [], destination, replacements, nativeReferences}));
    assert(!existsSync(count), 'Unsafe import must not invoke native Trash.');
    assert.equal(readFileSync(join(f.root, selection === 'self' ? destination : 'source/child'), 'utf8'), selection === 'self' ? 'original' : 'keep child');
  } finally { await runtime.dispose(); f.cleanup(); }
});

for (const kind of ['save', 'move'] as const) test(`R3 concurrent changed-payload ${kind} IDs reserve one immutable target before mutation`, async () => {
  const f = fixture(), count = join(f.base, 'effects');
  const command = kind === 'save' ? 'replace' : 'move';
  const helper = f.wrapper(`if [ "$1" = ${quote(command)} ]; then printf 'effect\\n' >> ${quote(count)}; fi`), {runtime, client} = f.start(helper);
  try {
    writeFileSync(join(f.root, 'other.txt'), 'original'); const checkout = await client.command('openCheckout', {root: f.root});
    const targets = ['file.txt', 'other.txt']; const disk = await client.command('readFile', {checkout, path: targets[0]});
    const sources = await client.command('inspectEntries', {checkout, paths: targets});
    const results = await Promise.allSettled(targets.map((path, i) => kind === 'save'
      ? client.command('saveFile', {clientId: 'alice', requestId: 'shared-id', target: {checkout, path}, text: 'saved-' + i, expectedVersion: disk.version})
      : client.command('mutate', {clientId: 'alice', id: 'shared-id', checkout, kind: 'move', sources: [sources[i]], destination: 'moved-' + i})));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && isError('Conflict')(r.reason)).length, 1);
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally { await runtime.dispose(); f.cleanup(); }
});

test('R4 concurrent lost-move reconciliation retains the original revision receipt and acknowledgement bounds', async () => {
  const f = fixture(), count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = move ]; then printf 'effect\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; kill -KILL $$; fi`);
  let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'file.txt'});
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: state(checkout, disk)});
    const sources = await current.client.command('inspectEntries', {checkout, paths: ['file.txt']});
    assert.equal((await current.client.command('mutate', {id: 'lost', clientId: 'alice', checkout, kind: 'move', sources, destination: 'moved.txt'})).outcome, 'uncertain');
    await current.runtime.dispose(); current = f.start();
    await Promise.all([current.client.command('operationStatus', {clientId: 'alice', id: 'lost'}), current.client.command('loadRecovery', {clientId: 'alice'})]);
    const receipt = await current.client.command('operationStatus', {clientId: 'alice', id: 'lost'});
    assert.deepEqual(receipt?.recoveryChanges, [{clientId: 'alice', previousRevision: 1, revision: 2}]);
    const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 2, state: loaded.state});
    await current.client.command('acknowledgeOperation', {clientId: 'alice', operationClientId: 'alice', id: 'lost'});
    assert.deepEqual((await current.client.command('operationStatus', {clientId: 'alice', id: 'lost'}))?.recoveryChanges, receipt?.recoveryChanges);
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

test('R5 copy recovery overflow retains a valid snapshot and pending evidence across restart without replay', async () => {
  const f = fixture(), count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = copy ]; then printf 'effect\\n' >> ${quote(count)}; fi`); let current = f.start(helper);
  try {
    mkdirSync(join(f.root, 'folder')); const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'file.txt'});
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], drafts: Array.from({length: 257}, (_, i) => ({target: {checkout, path: 'folder/' + i}, text: 'dirty-' + i, disk}))};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    const sources = await current.client.command('inspectEntries', {checkout, paths: ['folder']});
    const operation = {id: 'overflow', clientId: 'alice', checkout, kind: 'copy' as const, sources, destination: 'copied'};
    const result = await current.client.command('mutate', operation); assert.equal(result.items[0].outcome, 'completed');
    const retained = await current.client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(retained.revision, 1); assert.deepEqual(retained.state, snapshot); assert(retained.errors.some(e => /recovery|publication/i.test(e))); assert.equal(retained.operations.length, 1);
    await assert.rejects(current.client.command('acknowledgeOperation', {clientId: 'alice', operationClientId: 'alice', id: 'overflow'}), isError('Persistence'));
    await current.runtime.dispose(); current = f.start();
    const restarted = await current.client.command('loadRecovery', {clientId: 'alice'}); assert.deepEqual(restarted.state, snapshot); assert(restarted.errors.length);
    await current.client.command('mutate', operation); assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

for (const competing of [false, true]) test(`R6 interrupted newer Save plus external change ${competing ? 'preserves later competing publication' : 'restores admitted text over the older draft'}`, async () => {
  const f = fixture(), helper = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi'); let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await current.client.command('readFile', target);
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: state(checkout, disk)});
    writeFileSync(join(f.root, 'file.txt'), 'captured admission bytes'); const admittedBaseline = await current.client.command('readFile', target);
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'save', target, expectedVersion: admittedBaseline.version, text: 'newest admitted text'}), isError('Uncertain'));
    if (competing) await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: state(checkout, disk, 'later competing text')});
    writeFileSync(join(f.root, 'file.txt'), 'external bytes'); await current.runtime.dispose(); current = f.start();
    const restored = await current.client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(restored.state.drafts[0].text, competing ? 'later competing text' : 'newest admitted text'); assert.deepEqual(restored.state.drafts[0].disk, competing ? disk : admittedBaseline); assert(restored.errors.some(e => e.includes('Uncertain save')));
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'external bytes');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

test('R7 concurrent different operations can consume a native token only once', async () => {
  const f = fixture(), count = join(f.base, 'effects'); const helper = f.wrapper(`if [ "$1" = import ]; then printf 'effect\\n' >> ${quote(count)}; fi`), {runtime, client} = f.start(helper);
  try {
    const external = join(f.base, 'external'); writeFileSync(external, 'native bytes'); const checkout = await client.command('openCheckout', {root: f.root});
    const nativeReferences = await runtime.runPromise(Effect.flatMap(WorkspaceNative, native => native.capture({checkout, clientId: 'alice', paths: [external]})));
    const inputs = ['one', 'two'].map(id => ({clientId: 'alice', id, checkout, kind: 'import' as const, sources: [], nativeReferences, destination: id}));
    const outcomes = await Promise.allSettled(inputs.map(input => client.command('mutate', input)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled' && r.value.outcome === 'completed').length, 1); assert.equal(outcomes.filter(r => r.status === 'rejected' && isError('Unauthorized')(r.reason)).length, 1);
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
    const winner = outcomes.findIndex(r => r.status === 'fulfilled'); await client.command('mutate', inputs[winner]); assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally { await runtime.dispose(); f.cleanup(); }
});

test('R7 expiry cannot close a native descriptor after its operation has claimed it', async () => {
  const f = fixture(), ready = join(f.base, 'ready'), resume = join(f.base, 'resume');
  const helper = f.wrapper(`if [ "$1" = import ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(resume)} ]; do /bin/sleep 0.01; done; fi`), {runtime, client} = f.start(helper);
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const expirations: (() => void)[] = [], cancelled = new Set<unknown>();
  mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = originalTimeout(delay === 300000 ? () => {} : callback, delay, ...args);
    if (delay === 300000) expirations.push(() => { if (!cancelled.has(timer)) callback(...args); });
    return timer;
  });
  mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => { cancelled.add(timer); originalClear(timer); });
  try {
    const external = [join(f.base, 'external-one'), join(f.base, 'external-two')]; external.forEach(p => writeFileSync(p, 'native bytes')); mkdirSync(join(f.root, 'imports'));
    const checkout = await client.command('openCheckout', {root: f.root});
    const nativeReferences = await runtime.runPromise(Effect.flatMap(WorkspaceNative, native => native.capture({checkout, clientId: 'alice', paths: external})));
    const pending = client.command('mutate', {clientId: 'alice', id: 'expiry', checkout, kind: 'import', sources: [], nativeReferences, destination: 'imports'});
    await waitFor(ready); expirations.forEach(expire => expire()); writeFileSync(resume, 'continue');
    assert.equal((await pending).outcome, 'completed');
    for (const name of ['external-one', 'external-two']) assert.equal(readFileSync(join(f.root, 'imports', name), 'utf8'), 'native bytes');
  } finally { mock.restoreAll(); writeFileSync(resume, 'continue'); await runtime.dispose(); f.cleanup(); }
});

for (const kind of ['move', 'copy'] as const) test(`known closed checkout ${kind} metadata reconciles without probing its unavailable directory`, async () => {
  const f = fixture(), marker = join(f.base, 'closed'), count = join(f.base, 'io');
  const helper = f.wrapper(`if [ -e ${quote(marker)} ]; then printf 'io\\n' >> ${quote(count)}; fi`); let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'file.txt'});
    const snapshot: EditorRecovery = {...state(checkout, disk), openCheckoutIds: [], recentFiles: [{checkout, path: 'file.txt'}], views: {[checkout.checkoutId]: {openFiles: ['file.txt'], active: 'file.txt', preview: null, fileViews: {'file.txt': 'file'}, positions: {}, tree: {expanded: [], selected: [], focus: '', scroll: 0, hideIgnored: false}}}};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    const sources = await current.client.command('inspectEntries', {checkout, paths: ['file.txt']});
    await current.client.command('mutate', {id: 'closed-operation', clientId: 'alice', checkout, kind, sources, destination: 'moved.txt'});
    await current.runtime.dispose();
    const {renameSync} = await import('node:fs'); renameSync(f.root, f.root + '-unavailable'); writeFileSync(marker, 'closed'); current = f.start(helper);
    const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
    assert(!existsSync(count)); assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.state.checkouts, [checkout]); assert.deepEqual(loaded.state.openCheckoutIds, []);
    assert.equal(loaded.state.views[checkout.checkoutId].active, kind === 'move' ? 'moved.txt' : 'file.txt'); assert.equal(loaded.state.recentFiles[0].path, kind === 'move' ? 'moved.txt' : 'file.txt'); assert(loaded.state.drafts.some(d => d.target.path === 'moved.txt')); for (const d of loaded.state.drafts) assert.deepEqual(d.disk, disk);
    for (const invalid of [{...loaded.state, openCheckoutIds: [checkout.checkoutId, checkout.checkoutId]}, {...loaded.state, openCheckoutIds: ['unknown']}, {...loaded.state, selectedCheckoutId: checkout.checkoutId}, {...loaded.state, views: {'composite checkout key': loaded.state.views[checkout.checkoutId]}}])
      await assert.rejects(current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: loaded.revision, state: invalid}), isError('InvalidInput'));
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

for (const competing of [false, true]) test(`R2 interrupted Save group ${competing ? 'preserves a genuinely later client publication' : 'restores both admitted drafts in one revision across repeated restarts'}`, async () => {
  const f = fixture(), count = join(f.base, 'stage-count');
  const helper = f.wrapper(`if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`); let current = f.start(helper);
  try {
    for (const p of ['a.txt', 'b.txt']) writeFileSync(join(f.root, p), 'original ' + p);
    const checkout = await current.client.command('openCheckout', {root: f.root});
    const drafts = await Promise.all(['a.txt', 'b.txt'].map(async path => { const target = {checkout, path}; return {target, disk: await current.client.command('readFile', target), text: 'old ' + path}; }));
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    for (const {target, disk} of drafts) await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: target.path, target, expectedVersion: disk.version, text: 'admitted ' + target.path}), isError('Uncertain'));
    if (competing) await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: {...snapshot, drafts: drafts.map(d => ({...d, text: 'later ' + d.target.path}))}});
    if (!competing) for (const {target} of drafts) writeFileSync(join(f.root, target.path), 'external ' + target.path);
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose(); current = f.start();
      const loads = await Promise.all([current.client.command('loadRecovery', {clientId: 'alice'}), current.client.command('loadRecovery', {clientId: 'alice'})]);
      for (const loaded of loads) {
        assert.equal(loaded.revision, 2);
        assert.deepEqual(loaded.state.drafts.map(d => d.text), ['a.txt', 'b.txt'].map(p => (competing ? 'later ' : 'admitted ') + p));
        assert.deepEqual(loaded.state.drafts.map(d => d.disk), drafts.map(d => d.disk));
        assert(loaded.errors.some(e => e.includes('a.txt')) && loaded.errors.some(e => e.includes('b.txt')));
      }
    }
    assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
    for (const p of ['a.txt', 'b.txt']) assert.equal(readFileSync(join(f.root, p), 'utf8'), (competing ? 'original ' : 'external ') + p);
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

test('R2 interrupted Save group capacity overflow retains the entire prior valid snapshot and both pending intents', async () => {
  const f = fixture(), count = join(f.base, 'stage-count');
  const helper = f.wrapper(`if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`); let current = f.start(helper);
  try {
    for (const p of ['a.txt', 'b.txt']) writeFileSync(join(f.root, p), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'a.txt'});
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts: Array.from({length: 511}, (_, i) => ({target: {checkout, path: 'old/' + i}, text: 'old ' + i, disk}))};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    for (const path of ['a.txt', 'b.txt']) await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: path, target: {checkout, path}, expectedVersion: disk.version, text: 'admitted ' + path}), isError('Uncertain'));
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'external');
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose(); current = f.start();
      const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(loaded.revision, 1); assert.deepEqual(loaded.state, snapshot);
      for (const path of ['a.txt', 'b.txt']) assert(loaded.errors.some(e => e.includes(path)));
    }
    assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

for (const kind of ['move', 'copy'] as const) test(`R2 local ${kind} cannot replace an ancestor containing its selected dirty source`, async () => {
  const f = fixture(), count = join(f.base, 'trash-count');
  const helper = f.wrapper(`if [ "$1" = trash ]; then printf 'unsafe trash\\n' >> ${quote(count)}; exit 1; fi`), {runtime, client} = f.start(helper);
  try {
    mkdirSync(join(f.root, 'folder')); writeFileSync(join(f.root, 'folder/child.txt'), 'must survive');
    const checkout = await client.command('openCheckout', {root: f.root}), target = {checkout, path: 'folder/child.txt'}, disk = await client.command('readFile', target);
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts: [{target, disk, text: 'dirty child'}]};
    await client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    const sources = await client.command('inspectEntries', {checkout, paths: ['folder/child.txt']}), replacements = await client.command('inspectEntries', {checkout, paths: ['folder']});
    await assert.rejects(client.command('mutate', {clientId: 'alice', id: 'local-ancestor', checkout, kind, sources, replacements, destination: 'folder'}), isError('InvalidInput'));
    assert(!existsSync(count), 'Ancestor replacement must reject before native Trash.');
    assert.equal(await client.command('operationStatus', {clientId: 'alice', id: 'local-ancestor'}), null);
    assert.equal(readFileSync(join(f.root, 'folder/child.txt'), 'utf8'), 'must survive');
    assert.deepEqual((await client.command('loadRecovery', {clientId: 'alice'})).state, snapshot);
  } finally { await runtime.dispose(); f.cleanup(); }
});

test('R2 a client publication during grouped disk inspection stays authoritative', async () => {
  const f = fixture(), ready = join(f.base, 'read-ready'), release = join(f.base, 'read-release');
  const interrupted = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi');
  const paused = f.wrapper(`if [ "$1" = read ] && [ "$2" = a.txt ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi`);
  let current = f.start(interrupted);
  try {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'a.txt'});
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts: ['a.txt', 'b.txt'].map(path => ({target: {checkout, path}, disk, text: 'old ' + path}))};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    for (const path of ['a.txt', 'b.txt']) await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: path, target: {checkout, path}, text: 'admitted ' + path, expectedVersion: disk.version}), isError('Uncertain'));
    await current.runtime.dispose(); current = f.start(paused);
    const loading = current.client.command('loadRecovery', {clientId: 'alice'}); await waitFor(ready);
    const later = {...snapshot, drafts: snapshot.drafts.map(d => ({...d, text: 'later ' + d.target.path}))};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: later});
    writeFileSync(release, 'continue'); const loaded = await loading;
    assert.equal(loaded.revision, 2); assert.deepEqual(loaded.state, later); assert.equal(loaded.errors.length, 2);
  } finally { writeFileSync(release, 'continue'); await current.runtime.dispose(); f.cleanup(); }
});

test('R2 grouped Save publisher preserves visible persistence failure and clears pending on a non-replaying retry', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const f = fixture(), ready = join(f.base, 'saved'), release = join(f.base, 'release'), count = join(f.base, 'replace-count');
  const helper = f.wrapper(`if [ "$1" = replace ]; then printf 'replace\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; exit 0; fi`);
  const {runtime, client} = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await client.command('readFile', target);
    await client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: state(checkout, disk, 'saved text')});
    const input = {clientId: 'alice', requestId: 'publication', target, expectedVersion: disk.version, text: 'saved text'};
    const saving = client.command('saveFile', input); await waitFor(ready);
    const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE'); writeFileSync(release, 'continue'); const result = await saving;
      assert.equal(result.kind, 'saved'); assert(result.kind === 'saved' && result.persistencePending); assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'saved text');
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    const result = await client.command('saveFile', input);
    assert.equal(result.kind, 'saved'); assert(result.kind === 'saved' && !result.persistencePending);
    assert.deepEqual(result.kind === 'saved' && result.recoveryChanges, [{clientId: 'alice', previousRevision: 1, revision: 2}]);
    assert.deepEqual(await client.command('saveFile', input), result); assert.equal(readFileSync(count, 'utf8'), 'replace\n');
  } finally { writeFileSync(release, 'continue'); await runtime.dispose(); f.cleanup(); }
});

test('R3 retries cannot split an overflowing interrupted Save restoration group', async () => {
  const f = fixture(), count = join(f.base, 'stages');
  const helper = f.wrapper(`if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`); let current = f.start(helper);
  try {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), disk = await current.client.command('readFile', {checkout, path: 'a.txt'});
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts: Array.from({length: 511}, (_, i) => ({target: {checkout, path: 'old/' + i}, text: 'old ' + i, disk}))};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    const inputs = ['a.txt', 'b.txt'].map(path => ({clientId: 'alice', requestId: path, target: {checkout, path}, expectedVersion: disk.version, text: 'admitted ' + path}));
    for (const input of inputs) await assert.rejects(current.client.command('saveFile', input), isError('Uncertain'));
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose(); current = f.start();
      const before = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(before.revision, 1); assert.deepEqual(before.state, snapshot);
      const retries = await Promise.allSettled(inputs.map(input => current.client.command('saveFile', input)));
      assert(retries.every(r => r.status === 'rejected' && isError('Persistence')(r.reason)), 'Every retry must preserve the complete rejected group and report its persistence failure.');
      const after = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(after.revision, 1); assert.deepEqual(after.state, snapshot); assert.equal(after.errors.length, 2);
    }
    assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

for (const sibling of ['save', 'move'] as const) for (const competing of [false, true]) test(`R3 unrelated ${sibling} ${competing ? 'does not weaken a later client publication fence' : 'preserves pending interrupted text across internal revisions'}`, async () => {
  const f = fixture(), count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = stage ] && [ "$2" = a.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = replace ] || [ "$1" = move ]; then printf '%s\\n' "$1" >> ${quote(count)}; fi`); let current = f.start(helper);
  try {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root});
    const drafts = await Promise.all(['a.txt', 'b.txt'].map(async path => { const target = {checkout, path}; return {target, disk: await current.client.command('readFile', target), text: 'old ' + path}; }));
    const snapshot = {...emptyRecovery('alice'), checkouts: [checkout], openCheckoutIds: [checkout.checkoutId], drafts};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'a', target: drafts[0].target, expectedVersion: drafts[0].disk.version, text: 'admitted a'}), isError('Uncertain'));
    writeFileSync(join(f.root, 'a.txt'), 'external');
    if (sibling === 'save') {
      const result = await current.client.command('saveFile', {clientId: 'alice', requestId: 'b', target: drafts[1].target, expectedVersion: drafts[1].disk.version, text: 'saved b'});
      assert.equal(result.kind, 'saved'); assert.deepEqual(result.kind === 'saved' && result.recoveryChanges, [{clientId: 'alice', previousRevision: 1, revision: 2}]);
    } else {
      const sources = await current.client.command('inspectEntries', {checkout, paths: ['b.txt']});
      const result = await current.client.command('mutate', {clientId: 'alice', id: 'b', checkout, kind: 'move', sources, destination: 'moved-b.txt'});
      assert.equal(result.outcome, 'completed'); assert.deepEqual(result.recoveryChanges, [{clientId: 'alice', previousRevision: 1, revision: 2}]);
    }
    if (competing) await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 2, state: {...snapshot, drafts: drafts.map(d => ({...d, text: 'later ' + d.target.path}))}});
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose(); current = f.start();
      const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(loaded.revision, 3); assert.equal(loaded.state.drafts.find(d => d.target.path === 'a.txt')?.text, competing ? 'later a.txt' : 'admitted a');
      assert.deepEqual(loaded.state.drafts.find(d => d.target.path === 'a.txt')?.disk, drafts[0].disk);
      if (!competing) {
        const b = loaded.state.drafts.find(d => d.target.path === (sibling === 'move' ? 'moved-b.txt' : 'b.txt'));
        assert(b); assert.equal(b.text, 'old b.txt'); assert.equal(b.disk.text, sibling === 'save' ? 'saved b' : 'original');
      }
      assert.equal(loaded.errors.length, 1);
      await assert.rejects(current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: snapshot}), isError('Conflict'));
    }
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\n' + (sibling === 'save' ? 'replace' : 'move') + '\n');
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'external');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

test('R3 a genuine client publication during Save preflight fences later interrupted admission', async () => {
  const f = fixture(), pause = join(f.base, 'pause'), ready = join(f.base, 'ready'), release = join(f.base, 'release');
  const helper = f.wrapper(`if [ "$1" = read ] && [ -e ${quote(pause)} ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi\nif [ "$1" = stage ]; then kill -KILL $$; fi`); let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await current.client.command('readFile', target);
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: state(checkout, disk)});
    writeFileSync(pause, 'pause');
    const saving = current.client.command('saveFile', {clientId: 'alice', requestId: 'preflight', target, expectedVersion: disk.version, text: 'admitted before publication'});
    await waitFor(ready);
    const later = state(checkout, disk, 'newer client publication');
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: later});
    writeFileSync(release, 'continue'); await assert.rejects(saving, isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external'); await current.runtime.dispose(); current = f.start();
    const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(loaded.revision, 2); assert.deepEqual(loaded.state, later); assert.equal(loaded.errors.length, 1);
  } finally { writeFileSync(release, 'continue'); await current.runtime.dispose(); f.cleanup(); }
});

test('R3 unresolved same-target text blocks newer Save and Move effects', async () => {
  const f = fixture(), count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = stage ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = replace ] || [ "$1" = move ]; then printf 'unsafe\\n' >> ${quote(count)}; fi`), {runtime, client} = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await client.command('readFile', target);
    await client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: state(checkout, disk)});
    await assert.rejects(client.command('saveFile', {clientId: 'alice', requestId: 'old', target, expectedVersion: disk.version, text: 'pending text'}), isError('Uncertain'));
    await assert.rejects(client.command('saveFile', {clientId: 'alice', requestId: 'new', target, expectedVersion: disk.version, text: 'later text'}), isError('Uncertain'));
    const sources = await client.command('inspectEntries', {checkout, paths: ['file.txt']});
    await assert.rejects(client.command('mutate', {clientId: 'alice', id: 'move', checkout, kind: 'move', sources, destination: 'moved.txt'}), isError('Uncertain'));
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\n');
    assert.equal((await client.command('loadRecovery', {clientId: 'alice'})).state.drafts[0].text, 'pending text');
  } finally { await runtime.dispose(); f.cleanup(); }
});

for (const sibling of ['save', 'move'] as const) test(`R3 pending text survives a failed ${sibling} fact publication and its non-replaying retry`, async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const f = fixture(), ready = join(f.base, 'ready'), release = join(f.base, 'release'), count = join(f.base, 'effects'), command = sibling === 'save' ? 'replace' : 'move';
  const helper = f.wrapper(`if [ "$1" = stage ] && [ "$2" = file.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = ${command} ]; then printf 'effect\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; exit 0; fi`); let current = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await current.client.command('readFile', target);
    const snapshot = {...state(checkout, disk), drafts: [...state(checkout, disk).drafts, {target: {checkout, path: 'b.txt'}, disk, text: 'dirty b'}]};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'a', target, expectedVersion: disk.version, text: 'pending a'}), isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    const saveInput = {clientId: 'alice', requestId: 'b', target: {checkout, path: 'b.txt'}, expectedVersion: disk.version, text: 'saved b'};
    const moveInput = {clientId: 'alice', id: 'b', checkout, kind: 'move' as const, sources: await current.client.command('inspectEntries', {checkout, paths: ['b.txt']}), destination: 'moved-b.txt'};
    const pending = sibling === 'save' ? current.client.command('saveFile', saveInput) : current.client.command('mutate', moveInput);
    await waitFor(ready); const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE'); writeFileSync(release, 'continue'); const result = await pending;
      if ('outcome' in result) { assert.equal(result.items[0].outcome, 'completed'); assert.match(result.message!, /publication (?:failed|pending)/i); }
      else assert(result.kind === 'saved' && result.persistencePending);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    const retried = sibling === 'save' ? await current.client.command('saveFile', saveInput) : await current.client.command('mutate', moveInput);
    assert.deepEqual('recoveryChanges' in retried && retried.recoveryChanges, [{clientId: 'alice', previousRevision: 1, revision: 2}]);
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose(); current = f.start();
      const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(loaded.revision, 3); assert.equal(loaded.state.drafts.find(d => d.target.path === 'file.txt')?.text, 'pending a'); assert.equal(loaded.errors.length, 1);
      const replay = sibling === 'save' ? await current.client.command('saveFile', saveInput) : await current.client.command('mutate', moveInput);
      assert.deepEqual(replay, retried);
    }
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\neffect\n');
  } finally { writeFileSync(release, 'continue'); await current.runtime.dispose(); f.cleanup(); }
});

test('R3 foreign operation and restoration revisions do not acknowledge either observer without client publication', async () => {
  const f = fixture(), helper = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi'); let current = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await current.client.command('readFile', target);
    for (const clientId of ['alice', 'bob']) await current.client.command('persistRecovery', {clientId, expectedRevision: 0, state: {...state(checkout, disk), clientId, drafts: [...state(checkout, disk).drafts, {target: {checkout, path: 'b.txt'}, disk, text: clientId + ' dirty b'}]}});
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'a', target, expectedVersion: disk.version, text: 'pending a'}), isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    const sources = await current.client.command('inspectEntries', {checkout, paths: ['b.txt']});
    const moved = await current.client.command('mutate', {clientId: 'bob', id: 'move', checkout, kind: 'move', sources, destination: 'moved-b.txt'});
    assert.equal(moved.outcome, 'completed');
    await current.runtime.dispose(); current = f.start();
    const loads = await Promise.all(['alice', 'bob'].map(clientId => current.client.command('loadRecovery', {clientId})));
    assert.equal(loads[0].state.drafts.find(d => d.target.path === 'file.txt')?.text, 'pending a'); assert.equal(loads[0].revision, 3); assert.equal(loads[1].revision, 2);
    for (const clientId of ['alice', 'bob']) await assert.rejects(current.client.command('acknowledgeOperation', {clientId, operationClientId: 'bob', id: 'move'}), isError('Persistence'));
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 3, state: loads[0].state});
    await current.client.command('acknowledgeOperation', {clientId: 'alice', operationClientId: 'bob', id: 'move'});
    assert.equal((await current.client.command('loadRecovery', {clientId: 'alice'})).operations.length, 0);
    assert.equal((await current.client.command('loadRecovery', {clientId: 'bob'})).operations.length, 1);
    await assert.rejects(current.client.command('acknowledgeOperation', {clientId: 'bob', operationClientId: 'bob', id: 'move'}), isError('Persistence'));
    await current.client.command('persistRecovery', {clientId: 'bob', expectedRevision: 2, state: loads[1].state});
    await current.client.command('acknowledgeOperation', {clientId: 'bob', operationClientId: 'bob', id: 'move'});
  } finally { await current.runtime.dispose(); f.cleanup(); }
});

test('R3 complete restoration retries wait for an active sibling admission without publishing part of its group', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const f = fixture(), ready = join(f.base, 'ready'), release = join(f.base, 'release'), count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = stage ]; then printf '%s\\n' "$2" >> ${quote(count)}; if [ "$2" = file.txt ]; then kill -KILL $$; fi; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi`), {runtime, client} = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await client.command('readFile', target);
    const snapshot = {...state(checkout, disk), drafts: [...state(checkout, disk).drafts, {target: {checkout, path: 'b.txt'}, disk, text: 'dirty b'}]};
    await client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    const input = {clientId: 'alice', requestId: 'a', target, expectedVersion: disk.version, text: 'pending a'};
    await assert.rejects(client.command('saveFile', input), isError('Uncertain'));
    const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try { lock.exec('BEGIN IMMEDIATE'); assert.equal((await client.command('loadRecovery', {clientId: 'alice'})).revision, 1); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    const saving = client.command('saveFile', {clientId: 'alice', requestId: 'b', target: {checkout, path: 'b.txt'}, expectedVersion: disk.version, text: 'saved b'});
    await waitFor(ready);
    await assert.rejects(client.command('saveFile', input), isError('Persistence'));
    const during = await client.command('loadRecovery', {clientId: 'alice'}); assert.equal(during.revision, 1); assert.deepEqual(during.state, snapshot);
    writeFileSync(release, 'continue'); assert.equal((await saving).kind, 'saved');
    assert.equal((await client.command('saveFile', input)).kind, 'conflict');
    const after = await client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(after.revision, 3); assert.equal(after.state.drafts[0].text, 'pending a'); assert.equal(readFileSync(count, 'utf8'), 'file.txt\nb.txt\n');
  } finally { writeFileSync(release, 'continue'); await runtime.dispose(); f.cleanup(); }
});

for (const sibling of ['save', 'move', 'later-publication'] as const) test(`R3 pre-fence Moonbase journal ${sibling} uses only complete internal receipt chains`, async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const f = fixture(), count = join(f.base, 'effects'), helper = f.wrapper(`if [ "$1" = stage ] && [ "$2" = file.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = replace ] || [ "$1" = move ]; then printf 'effect\\n' >> ${quote(count)}; fi`); let current = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await current.client.command('openCheckout', {root: f.root}), target = {checkout, path: 'file.txt'}, disk = await current.client.command('readFile', target);
    const snapshot = {...state(checkout, disk), drafts: [...state(checkout, disk).drafts, {target: {checkout, path: 'b.txt'}, disk, text: 'dirty b'}]};
    await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 0, state: snapshot});
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'a', target, expectedVersion: disk.version, text: 'pending a'}), isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    if (sibling === 'move') await current.client.command('mutate', {clientId: 'alice', id: 'b', checkout, kind: 'move', sources: await current.client.command('inspectEntries', {checkout, paths: ['b.txt']}), destination: 'moved-b.txt'});
    else await current.client.command('saveFile', {clientId: 'alice', requestId: 'b', target: {checkout, path: 'b.txt'}, expectedVersion: disk.version, text: 'saved b'});
    if (sibling === 'later-publication') await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 2, state: {...snapshot, drafts: snapshot.drafts.map(d => ({...d, text: 'later client text'}))}});
    await current.runtime.dispose();
    const db = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      // Recreate the previous module's private journal format; no application/legacy source state is imported.
      db.prepare('DELETE FROM records WHERE bucket=?').run('publications');
      for (const row of db.prepare('SELECT key, body FROM records WHERE bucket=?').all('saves')) {
        const record = JSON.parse(row.body as string); if (record.input.requestId !== 'a') continue;
        delete record.recoveryPublication; record.recoveryRevision = 1;
        db.prepare('UPDATE records SET body=? WHERE bucket=? AND key=?').run(JSON.stringify(record), 'saves', row.key);
      }
    } finally { db.close(); }
    for (let restart = 0; restart < 2; restart++) {
      current = f.start(); const loaded = await current.client.command('loadRecovery', {clientId: 'alice'});
      assert.equal(loaded.revision, 3); assert.equal(loaded.state.drafts[0].text, sibling === 'later-publication' ? 'later client text' : 'pending a'); assert.equal(loaded.errors.length, 1);
      await current.runtime.dispose();
    }
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\neffect\n');
  } finally { await current.runtime.dispose(); f.cleanup(); }
});
