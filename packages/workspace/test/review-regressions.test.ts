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
  return {...emptyRecovery('alice'), checkouts: [checkout], drafts: [{target: {checkout, path: 'file.txt'}, disk, text}]};
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
  } finally { await runtime.dispose(); f.cleanup(); }
});

for (const directory of [false, true]) test(`R2 native ${directory ? 'directory descendant' : 'self'} import rejects before replacement Trash`, async () => {
  const f = fixture(), count = join(f.base, 'trash-count');
  const helper = f.wrapper(`if [ "$1" = trash ]; then printf 'trash\\n' >> ${quote(count)}; exit 1; fi`), {runtime, client} = f.start(helper);
  try {
    if (directory) { mkdirSync(join(f.root, 'source')); writeFileSync(join(f.root, 'source/child'), 'keep child'); }
    const checkout = await client.command('openCheckout', {root: f.root}), source = directory ? 'source' : 'file.txt', destination = directory ? 'source/child' : source;
    const nativeReferences = await runtime.runPromise(Effect.flatMap(WorkspaceNative, native => native.capture({checkout, clientId: 'alice', paths: [join(f.root, source)]})));
    const replacements = await client.command('inspectEntries', {checkout, paths: [destination]});
    await assert.rejects(client.command('mutate', {id: 'self-import', clientId: 'alice', checkout, kind: 'import', sources: [], destination, replacements, nativeReferences}));
    assert(!existsSync(count), 'Unsafe import must not invoke native Trash.');
    assert.equal(readFileSync(join(f.root, destination), 'utf8'), directory ? 'keep child' : 'original');
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
    await assert.rejects(current.client.command('saveFile', {clientId: 'alice', requestId: 'save', target, expectedVersion: disk.version, text: 'newest admitted text'}), isError('Uncertain'));
    if (competing) await current.client.command('persistRecovery', {clientId: 'alice', expectedRevision: 1, state: state(checkout, disk, 'later competing text')});
    writeFileSync(join(f.root, 'file.txt'), 'external bytes'); await current.runtime.dispose(); current = f.start();
    const restored = await current.client.command('loadRecovery', {clientId: 'alice'});
    assert.equal(restored.state.drafts[0].text, competing ? 'later competing text' : 'newest admitted text'); assert.deepEqual(restored.state.drafts[0].disk, disk); assert(restored.errors.some(e => e.includes('Uncertain save')));
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
