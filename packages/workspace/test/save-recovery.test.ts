import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import type { RecoveryState } from '@moonbase/contracts/recovery';
import {
  binary,
  bufferIdOf,
  draftsOf,
  quote,
  fixture,
  isError,
  seed,
  waitFor,
  type SeedDraft,
} from './recovery-fixture.ts';

type Client = ReturnType<ReturnType<typeof fixture>['start']>['client'];
const load = (client: Client) => client.command('loadRecovery', { clientId: 'alice' });
/** Types new text into each of alice's seeded drafts: the window's word, newer than any save. */
const retype = async (client: Client, drafts: SeedDraft[], text: (draft: SeedDraft) => string) => {
  for (const draft of drafts)
    await client.command('updateDraft', {
      clientId: 'alice',
      bufferId: bufferIdOf(draft.target),
      text: text(draft),
      disk: draft.disk,
    });
};
/** Alice's stored recovery revision under `base`: each publication of her recovery adds one. */
const revisionOf = (base: string) => {
  const db = new DatabaseSync(join(base, 'state/moonbase-workspace-v1.sqlite'));
  try {
    const row = db.prepare("SELECT revision FROM recovery WHERE client = 'alice'").get();
    return Number(row?.revision ?? 0);
  } finally {
    db.close();
  }
};
/** Asserts that `change` publishes alice's recovery exactly once. */
const assertOnePublication = async <T>(base: string, change: () => Promise<T>) => {
  const before = revisionOf(base);
  const value = await change();
  assert.equal(revisionOf(base), before + 1, 'expected one recovery publication');
  return value;
};
/** The layout part of a recovery, for an `updateLayout`. */
const layoutOf = ({ version: _v, clientId: _c, buffers: _b, ...layout }: RecoveryState) => layout;

test('concurrent lost-move reconciliation publishes once and acknowledgement keeps its result', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  const helper = f.wrapper(
    `if [ "$1" = move ]; then printf 'effect\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; kill -KILL $$; fi`,
  );
  let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'file.txt' });
    await seed(current.client, 'alice', [
      { target: { checkout, path: 'file.txt' }, text: 'older draft', disk },
    ]);
    const sources = await current.client.command('inspectEntries', {
      checkout,
      paths: ['file.txt'],
    });
    assert.equal(
      (
        await current.client.command('mutate', {
          id: 'lost',
          clientId: 'alice',
          checkout,
          kind: 'move',
          sources,
          destination: 'moved.txt',
        })
      ).outcome,
      'uncertain',
    );
    await current.runtime.dispose();
    current = f.start();
    await assertOnePublication(f.base, () =>
      Promise.all([
        current.client.command('operationStatus', { clientId: 'alice', id: 'lost' }),
        current.client.command('loadRecovery', { clientId: 'alice' }),
      ]),
    );
    const receipt = await current.client.command('operationStatus', {
      clientId: 'alice',
      id: 'lost',
    });
    assert.equal(receipt?.outcome, 'completed');
    await current.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'alice',
      id: 'lost',
    });
    assert.deepEqual(
      await current.client.command('operationStatus', { clientId: 'alice', id: 'lost' }),
      receipt,
    );
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('copy recovery overflow retains a valid snapshot and pending evidence across restart without replay', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  const helper = f.wrapper(`if [ "$1" = copy ]; then printf 'effect\\n' >> ${quote(count)}; fi`);
  let current = f.start(helper);
  try {
    mkdirSync(join(f.root, 'folder'));
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'file.txt' });
    await seed(
      current.client,
      'alice',
      Array.from({ length: 257 }, (_, i) => ({
        target: { checkout, path: 'folder/' + i },
        text: 'dirty-' + i,
        disk,
      })),
    );
    const snapshot = (await load(current.client)).state;
    const sources = await current.client.command('inspectEntries', { checkout, paths: ['folder'] });
    const operation = {
      id: 'overflow',
      clientId: 'alice',
      checkout,
      kind: 'copy' as const,
      sources,
      destination: 'copied',
    };
    const result = await current.client.command('mutate', operation);
    assert.equal(result.items[0].outcome, 'completed');
    const retained = await load(current.client);
    assert.deepEqual(retained.state, snapshot);
    assert(retained.errors.some((e) => /recovery|publication/i.test(e)));
    assert.equal(retained.operations.length, 1);
    await assert.rejects(
      current.client.command('acknowledgeOperation', {
        clientId: 'alice',
        operationClientId: 'alice',
        id: 'overflow',
      }),
      isError('Persistence'),
    );
    await current.runtime.dispose();
    current = f.start();
    const restarted = await current.client.command('loadRecovery', { clientId: 'alice' });
    assert.deepEqual(restarted.state, snapshot);
    assert(restarted.errors.length);
    await current.client.command('mutate', operation);
    assert.equal(readFileSync(count, 'utf8'), 'effect\n');
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});

for (const competing of [false, true])
  test(`interrupted newer Save plus external change ${competing ? 'preserves later competing publication' : 'restores admitted text over the older draft'}`, async () => {
    const f = fixture(),
      helper = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi');
    let current = f.start(helper);
    try {
      const checkout = await current.client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'file.txt' },
        disk = await current.client.command('readFile', target);
      const seeded = [{ target, text: 'older draft', disk }];
      await seed(current.client, 'alice', seeded);
      writeFileSync(join(f.root, 'file.txt'), 'captured admission bytes');
      const admittedBaseline = await current.client.command('readFile', target);
      await assert.rejects(
        current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'save',
          target,
          expectedVersion: admittedBaseline.version,
          text: 'newest admitted text',
        }),
        isError('Uncertain'),
      );
      if (competing) await retype(current.client, seeded, () => 'later competing text');
      writeFileSync(join(f.root, 'file.txt'), 'external bytes');
      await current.runtime.dispose();
      current = f.start();
      const [restored] = draftsOf((await load(current.client)).state);
      assert.equal(restored?.text, competing ? 'later competing text' : 'newest admitted text');
      assert.deepEqual(restored?.disk, competing ? disk : admittedBaseline);
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'external bytes');
    } finally {
      await current.runtime.dispose();
      f.cleanup();
    }
  });

for (const kind of ['move', 'copy'] as const)
  test(`known closed checkout ${kind} metadata reconciles without probing its unavailable directory`, async () => {
    const f = fixture(),
      marker = join(f.base, 'closed'),
      count = join(f.base, 'io');
    const helper = f.wrapper(
      `if [ -e ${quote(marker)} ]; then printf 'io\\n' >> ${quote(count)}; fi`,
    );
    let current = f.start(helper);
    try {
      const checkout = await current.client.command('openCheckout', { root: f.root }),
        disk = await current.client.command('readFile', { checkout, path: 'file.txt' });
      const target = { checkout, path: 'file.txt' },
        bufferId = bufferIdOf(target);
      const layout = {
        checkouts: [checkout],
        openCheckoutIds: [],
        selectedCheckoutId: null,
        recentFiles: [target],
        sidebarWidth: 270,
        views: {},
      };
      await seed(current.client, 'alice', [{ target, text: 'older draft', disk }], layout);
      await current.client.command('updateLayout', {
        clientId: 'alice',
        layout: {
          ...layout,
          views: {
            [checkout.checkoutId]: {
              tabs: [bufferId],
              active: bufferId,
              preview: null,
              fileViews: { [bufferId]: 'file' },
              positions: {},
              remembered: {},
              tree: { expanded: [], selected: [], focus: '', scroll: 0, hideIgnoredFiles: false },
            },
          },
        },
      });
      const sources = await current.client.command('inspectEntries', {
        checkout,
        paths: ['file.txt'],
      });
      await current.client.command('mutate', {
        id: 'closed-operation',
        clientId: 'alice',
        checkout,
        kind,
        sources,
        destination: 'moved.txt',
      });
      await current.runtime.dispose();
      const { renameSync } = await import('node:fs');
      renameSync(f.root, f.root + '-unavailable');
      writeFileSync(marker, 'closed');
      current = f.start(helper);
      const loaded = await load(current.client);
      assert(!existsSync(count));
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.state.checkouts, [checkout]);
      assert.deepEqual(loaded.state.openCheckoutIds, []);
      const active = loaded.state.views[checkout.checkoutId]?.active;
      assert.equal(
        loaded.state.buffers.find((b) => b.id === active)?.target.path,
        kind === 'move' ? 'moved.txt' : 'file.txt',
      );
      assert.equal(loaded.state.recentFiles[0].path, kind === 'move' ? 'moved.txt' : 'file.txt');
      const drafts = draftsOf(loaded.state);
      assert(drafts.some((d) => d.target.path === 'moved.txt'));
      for (const d of drafts) assert.deepEqual(d.disk, disk);
      const stored = layoutOf(loaded.state);
      for (const invalid of [
        { ...stored, openCheckoutIds: [checkout.checkoutId, checkout.checkoutId] },
        { ...stored, openCheckoutIds: ['unknown'] },
        { ...stored, selectedCheckoutId: checkout.checkoutId },
        {
          ...stored,
          views: { 'composite checkout key': stored.views[checkout.checkoutId]! },
        },
      ])
        await assert.rejects(
          current.client.command('updateLayout', { clientId: 'alice', layout: invalid }),
          isError('InvalidInput'),
        );
    } finally {
      await current.runtime.dispose();
      f.cleanup();
    }
  });

for (const competing of [false, true])
  test(`interrupted Save group ${competing ? 'preserves a genuinely later client publication' : 'restores both admitted drafts in one revision across repeated restarts'}`, async () => {
    const f = fixture(),
      count = join(f.base, 'stage-count');
    const helper = f.wrapper(
      `if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`,
    );
    let current = f.start(helper);
    try {
      for (const p of ['a.txt', 'b.txt']) writeFileSync(join(f.root, p), 'original ' + p);
      const checkout = await current.client.command('openCheckout', { root: f.root });
      const drafts = await Promise.all(
        ['a.txt', 'b.txt'].map(async (path) => {
          const target = { checkout, path };
          return {
            target,
            disk: await current.client.command('readFile', target),
            text: 'old ' + path,
          };
        }),
      );
      await seed(current.client, 'alice', drafts);
      for (const { target, disk } of drafts)
        await assert.rejects(
          current.client.command('saveFile', {
            clientId: 'alice',
            requestId: target.path,
            target,
            expectedVersion: disk.version,
            text: 'admitted ' + target.path,
          }),
          isError('Uncertain'),
        );
      if (competing) await retype(current.client, drafts, (d) => 'later ' + d.target.path);
      if (!competing)
        for (const { target } of drafts)
          writeFileSync(join(f.root, target.path), 'external ' + target.path);
      for (let restart = 0; restart < 2; restart++) {
        await current.runtime.dispose();
        current = f.start();
        const loads = await Promise.all([load(current.client), load(current.client)]);
        // Both loads see the whole group restored, never one save of it.
        assert.deepEqual(loads[0].state, loads[1].state);
        assert.deepEqual(
          draftsOf(loads[0].state),
          drafts.map((d) => ({ ...d, text: (competing ? 'later ' : 'admitted ') + d.target.path })),
        );
      }
      assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
      for (const p of ['a.txt', 'b.txt'])
        assert.equal(
          readFileSync(join(f.root, p), 'utf8'),
          (competing ? 'original ' : 'external ') + p,
        );
    } finally {
      await current.runtime.dispose();
      f.cleanup();
    }
  });

test('interrupted Save group capacity overflow retains the entire prior valid snapshot and both pending intents', async () => {
  const f = fixture(),
    count = join(f.base, 'stage-count');
  const helper = f.wrapper(
    `if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`,
  );
  let current = f.start(helper);
  try {
    for (const p of ['a.txt', 'b.txt']) writeFileSync(join(f.root, p), 'original');
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'a.txt' });
    await seed(
      current.client,
      'alice',
      Array.from({ length: 511 }, (_, i) => ({
        target: { checkout, path: 'old/' + i },
        text: 'old ' + i,
        disk,
      })),
    );
    const snapshot = (await load(current.client)).state;
    for (const path of ['a.txt', 'b.txt'])
      await assert.rejects(
        current.client.command('saveFile', {
          clientId: 'alice',
          requestId: path,
          target: { checkout, path },
          expectedVersion: disk.version,
          text: 'admitted ' + path,
        }),
        isError('Uncertain'),
      );
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'external');
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose();
      current = f.start();
      const loaded = await load(current.client);
      assert.deepEqual(loaded.state, snapshot);
      for (const path of ['a.txt', 'b.txt']) assert(loaded.errors.some((e) => e.includes(path)));
    }
    assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('a client publication during grouped disk inspection stays authoritative', async () => {
  const f = fixture(),
    ready = join(f.base, 'read-ready'),
    release = join(f.base, 'read-release');
  const interrupted = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi');
  const paused = f.wrapper(
    `if [ "$1" = read ] && [ "$2" = a.txt ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi`,
  );
  let current = f.start(interrupted);
  try {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'a.txt' });
    const drafts = ['a.txt', 'b.txt'].map((path) => ({
      target: { checkout, path },
      disk,
      text: 'old ' + path,
    }));
    await seed(current.client, 'alice', drafts);
    for (const path of ['a.txt', 'b.txt'])
      await assert.rejects(
        current.client.command('saveFile', {
          clientId: 'alice',
          requestId: path,
          target: { checkout, path },
          text: 'admitted ' + path,
          expectedVersion: disk.version,
        }),
        isError('Uncertain'),
      );
    await current.runtime.dispose();
    current = f.start(paused);
    const loading = current.client.command('loadRecovery', { clientId: 'alice' });
    await waitFor(ready);
    await retype(current.client, drafts, (d) => 'later ' + d.target.path);
    writeFileSync(release, 'continue');
    const loaded = await loading;
    assert.deepEqual(
      draftsOf(loaded.state),
      drafts.map((d) => ({ ...d, text: 'later ' + d.target.path })),
    );
    // The host finds both files unchanged, and the later edits are the client's newer word.
    assert.deepEqual(loaded.errors, []);
  } finally {
    writeFileSync(release, 'continue');
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('grouped Save publisher preserves visible persistence failure and clears pending on a non-replaying retry', async () => {
  const f = fixture(),
    ready = join(f.base, 'saved'),
    release = join(f.base, 'release'),
    count = join(f.base, 'replace-count');
  const helper = f.wrapper(
    `if [ "$1" = replace ]; then printf 'replace\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; exit 0; fi`,
  );
  const { runtime, client } = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    await seed(client, 'alice', [{ target, text: 'saved text', disk }]);
    const input = {
      clientId: 'alice',
      requestId: 'publication',
      target,
      expectedVersion: disk.version,
      text: 'saved text',
    };
    const saving = client.command('saveFile', input);
    await waitFor(ready);
    const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      writeFileSync(release, 'continue');
      const result = await saving;
      assert.equal(result.kind, 'saved');
      assert(result.kind === 'saved' && result.persistencePending);
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'saved text');
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    const result = await assertOnePublication(f.base, () => client.command('saveFile', input));
    assert.equal(result.kind, 'saved');
    assert(result.kind === 'saved' && !result.persistencePending);
    assert.deepEqual(await client.command('saveFile', input), result);
    assert.equal(readFileSync(count, 'utf8'), 'replace\n');
  } finally {
    writeFileSync(release, 'continue');
    await runtime.dispose();
    f.cleanup();
  }
});

test('retries cannot split an overflowing interrupted Save restoration group', async () => {
  const f = fixture(),
    count = join(f.base, 'stages');
  const helper = f.wrapper(
    `if [ "$1" = stage ]; then printf 'stage\\n' >> ${quote(count)}; kill -KILL $$; fi`,
  );
  let current = f.start(helper);
  try {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'a.txt' });
    await seed(
      current.client,
      'alice',
      Array.from({ length: 511 }, (_, i) => ({
        target: { checkout, path: 'old/' + i },
        text: 'old ' + i,
        disk,
      })),
    );
    const snapshot = (await load(current.client)).state;
    const inputs = ['a.txt', 'b.txt'].map((path) => ({
      clientId: 'alice',
      requestId: path,
      target: { checkout, path },
      expectedVersion: disk.version,
      text: 'admitted ' + path,
    }));
    for (const input of inputs)
      await assert.rejects(current.client.command('saveFile', input), isError('Uncertain'));
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose();
      current = f.start();
      const before = await load(current.client);
      assert.deepEqual(before.state, snapshot);
      const retries = await Promise.allSettled(
        inputs.map((input) => current.client.command('saveFile', input)),
      );
      assert(
        retries.every((r) => r.status === 'rejected' && isError('Persistence')(r.reason)),
        'Every retry must preserve the complete rejected group and report its persistence failure.',
      );
      const after = await load(current.client);
      assert.deepEqual(after.state, snapshot);
      assert.equal(after.errors.length, 2);
    }
    assert.equal(readFileSync(count, 'utf8'), 'stage\nstage\n');
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});

for (const sibling of ['save', 'move'] as const)
  for (const competing of [false, true])
    test(`unrelated ${sibling} ${competing ? 'keeps a later edit over the interrupted save' : 'preserves pending interrupted text across internal revisions'}`, async () => {
      const f = fixture(),
        count = join(f.base, 'effects');
      const helper = f.wrapper(
        `if [ "$1" = stage ] && [ "$2" = a.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = replace ] || [ "$1" = move ]; then printf '%s\\n' "$1" >> ${quote(count)}; fi`,
      );
      let current = f.start(helper);
      try {
        for (const path of ['a.txt', 'b.txt']) writeFileSync(join(f.root, path), 'original');
        const checkout = await current.client.command('openCheckout', { root: f.root });
        const drafts = await Promise.all(
          ['a.txt', 'b.txt'].map(async (path) => {
            const target = { checkout, path };
            return {
              target,
              disk: await current.client.command('readFile', target),
              text: 'old ' + path,
            };
          }),
        );
        await seed(current.client, 'alice', drafts);
        await assert.rejects(
          current.client.command('saveFile', {
            clientId: 'alice',
            requestId: 'a',
            target: drafts[0].target,
            expectedVersion: drafts[0].disk.version,
            text: 'admitted a',
          }),
          isError('Uncertain'),
        );
        writeFileSync(join(f.root, 'a.txt'), 'external');
        if (sibling === 'save') {
          const result = await assertOnePublication(f.base, () =>
            current.client.command('saveFile', {
              clientId: 'alice',
              requestId: 'b',
              target: drafts[1].target,
              expectedVersion: drafts[1].disk.version,
              text: 'saved b',
            }),
          );
          assert.equal(result.kind, 'saved');
        } else {
          const sources = await current.client.command('inspectEntries', {
            checkout,
            paths: ['b.txt'],
          });
          const result = await assertOnePublication(f.base, () =>
            current.client.command('mutate', {
              clientId: 'alice',
              id: 'b',
              checkout,
              kind: 'move',
              sources,
              destination: 'moved-b.txt',
            }),
          );
          assert.equal(result.outcome, 'completed');
        }
        if (competing) await retype(current.client, drafts, (d) => 'later ' + d.target.path);
        for (let restart = 0; restart < 2; restart++) {
          await current.runtime.dispose();
          current = f.start();
          const loaded = draftsOf((await load(current.client)).state);
          assert.equal(
            loaded.find((d) => d.target.path === 'a.txt')?.text,
            competing ? 'later a.txt' : 'admitted a',
          );
          assert.deepEqual(loaded.find((d) => d.target.path === 'a.txt')?.disk, drafts[0].disk);
          if (!competing) {
            const b = loaded.find(
              (d) => d.target.path === (sibling === 'move' ? 'moved-b.txt' : 'b.txt'),
            );
            assert(b);
            assert.equal(b.text, 'old b.txt');
            assert.equal(b.disk.text, sibling === 'save' ? 'saved b' : 'original');
          }
        }
        assert.equal(
          readFileSync(count, 'utf8'),
          'interrupted\n' + (sibling === 'save' ? 'replace' : 'move') + '\n',
        );
        assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'external');
      } finally {
        await current.runtime.dispose();
        f.cleanup();
      }
    });

test('an edit during Save preflight wins over the interrupted save it began before', async () => {
  const f = fixture(),
    pause = join(f.base, 'pause'),
    ready = join(f.base, 'ready'),
    release = join(f.base, 'release');
  const helper = f.wrapper(
    `if [ "$1" = read ] && [ -e ${quote(pause)} ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi\nif [ "$1" = stage ]; then kill -KILL $$; fi`,
  );
  let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await current.client.command('readFile', target);
    const seeded = [{ target, text: 'older draft', disk }];
    await seed(current.client, 'alice', seeded);
    writeFileSync(pause, 'pause');
    const saving = current.client.command('saveFile', {
      clientId: 'alice',
      requestId: 'preflight',
      target,
      expectedVersion: disk.version,
      text: 'admitted before publication',
    });
    await waitFor(ready);
    await retype(current.client, seeded, () => 'newer client edit');
    writeFileSync(release, 'continue');
    await assert.rejects(saving, isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    await current.runtime.dispose();
    current = f.start();
    const loaded = await load(current.client);
    assert.deepEqual(draftsOf(loaded.state), [{ target, text: 'newer client edit', disk }]);
    // The host settles the save as a conflict, and the later edit is the client's word.
    assert.deepEqual(loaded.errors, []);
  } finally {
    writeFileSync(release, 'continue');
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('unresolved same-target text blocks newer Save and Move effects', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  const helper = f.wrapper(
      `if [ "$1" = stage ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = replace ] || [ "$1" = move ]; then printf 'unsafe\\n' >> ${quote(count)}; fi`,
    ),
    { runtime, client } = f.start(helper);
  try {
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    await seed(client, 'alice', [{ target, text: 'older draft', disk }]);
    await assert.rejects(
      client.command('saveFile', {
        clientId: 'alice',
        requestId: 'old',
        target,
        expectedVersion: disk.version,
        text: 'pending text',
      }),
      isError('Uncertain'),
    );
    await assert.rejects(
      client.command('saveFile', {
        clientId: 'alice',
        requestId: 'new',
        target,
        expectedVersion: disk.version,
        text: 'later text',
      }),
      isError('Uncertain'),
    );
    const sources = await client.command('inspectEntries', { checkout, paths: ['file.txt'] });
    await assert.rejects(
      client.command('mutate', {
        clientId: 'alice',
        id: 'move',
        checkout,
        kind: 'move',
        sources,
        destination: 'moved.txt',
      }),
      isError('Uncertain'),
    );
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\n');
    assert.equal(draftsOf((await load(client)).state)[0]?.text, 'pending text');
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

test('an interrupted save the disk no longer shows settles as a conflict and blocks no other save', async () => {
  const f = fixture(),
    once = join(f.base, 'interrupted');
  const helper = f.wrapper(
    `if [ "$1" = stage ] && [ ! -e ${quote(once)} ]; then /usr/bin/touch ${quote(once)}; kill -KILL $$; fi`,
  );
  const { runtime } = f.start(helper);
  try {
    const host = await runtime.runPromise(WorkspaceHostService);
    const checkout = await Effect.runPromise(host.openCheckout({ root: f.root })),
      target = { checkout, path: 'file.txt' },
      disk = await Effect.runPromise(host.readFile(target));
    const save = (clientId: string, text: string, expectedVersion: string) =>
      Effect.runPromise(
        host.saveFile({
          installationId: 'test-installation',
          clientId,
          requestId: 'save',
          target,
          text,
          expectedVersion,
        }),
      );
    await assert.rejects(save('alice', 'admitted', disk.version), isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    const external = await Effect.runPromise(host.readFile(target));
    // Another client may still save there: the host settles the first save from the disk.
    assert.equal((await save('bob', 'bob text', external.version)).kind, 'saved');
    const status = await Effect.runPromise(
      host.saveStatus({
        installationId: 'test-installation',
        clientId: 'alice',
        requestId: 'save',
      }),
    );
    assert.deepEqual(status, { kind: 'conflict', disk: external });
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

for (const sibling of ['save', 'move'] as const)
  test(`pending text survives a failed ${sibling} fact publication and its non-replaying retry`, async () => {
    const f = fixture(),
      ready = join(f.base, 'ready'),
      release = join(f.base, 'release'),
      count = join(f.base, 'effects'),
      command = sibling === 'save' ? 'replace' : 'move';
    const helper = f.wrapper(
      `if [ "$1" = stage ] && [ "$2" = file.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi\nif [ "$1" = ${command} ]; then printf 'effect\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; exit 0; fi`,
    );
    let current = f.start(helper);
    try {
      writeFileSync(join(f.root, 'b.txt'), 'original');
      const checkout = await current.client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'file.txt' },
        disk = await current.client.command('readFile', target);
      await seed(current.client, 'alice', [
        { target, text: 'older draft', disk },
        { target: { checkout, path: 'b.txt' }, disk, text: 'dirty b' },
      ]);
      await assert.rejects(
        current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'a',
          target,
          expectedVersion: disk.version,
          text: 'pending a',
        }),
        isError('Uncertain'),
      );
      writeFileSync(join(f.root, 'file.txt'), 'external');
      const saveInput = {
        clientId: 'alice',
        requestId: 'b',
        target: { checkout, path: 'b.txt' },
        expectedVersion: disk.version,
        text: 'saved b',
      };
      const moveInput = {
        clientId: 'alice',
        id: 'b',
        checkout,
        kind: 'move' as const,
        sources: await current.client.command('inspectEntries', { checkout, paths: ['b.txt'] }),
        destination: 'moved-b.txt',
      };
      const pending =
        sibling === 'save'
          ? current.client.command('saveFile', saveInput)
          : current.client.command('mutate', moveInput);
      await waitFor(ready);
      const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
      try {
        lock.exec('BEGIN IMMEDIATE');
        writeFileSync(release, 'continue');
        const result = await pending;
        if ('outcome' in result) {
          assert.equal(result.items[0].outcome, 'completed');
          assert.match(result.message!, /publication (?:failed|pending)/i);
        } else assert(result.kind === 'saved' && result.persistencePending);
      } finally {
        lock.exec('ROLLBACK');
        lock.close();
      }
      const retried = await assertOnePublication(f.base, async () =>
        sibling === 'save'
          ? await current.client.command('saveFile', saveInput)
          : await current.client.command('mutate', moveInput),
      );
      for (let restart = 0; restart < 2; restart++) {
        await current.runtime.dispose();
        current = f.start();
        const loaded = draftsOf((await load(current.client)).state);
        assert.equal(loaded.find((d) => d.target.path === 'file.txt')?.text, 'pending a');
        const replay =
          sibling === 'save'
            ? await current.client.command('saveFile', saveInput)
            : await current.client.command('mutate', moveInput);
        assert.deepEqual(replay, retried);
      }
      assert.equal(readFileSync(count, 'utf8'), 'interrupted\neffect\n');
    } finally {
      writeFileSync(release, 'continue');
      await current.runtime.dispose();
      f.cleanup();
    }
  });

test('complete restoration retries wait for an active sibling admission without publishing part of its group', async () => {
  const f = fixture(),
    ready = join(f.base, 'ready'),
    release = join(f.base, 'release'),
    count = join(f.base, 'effects');
  const helper = f.wrapper(
      `if [ "$1" = stage ]; then printf '%s\\n' "$2" >> ${quote(count)}; if [ "$2" = file.txt ]; then kill -KILL $$; fi; /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi`,
    ),
    { runtime, client } = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await client.command('readFile', target);
    await seed(client, 'alice', [
      { target, text: 'older draft', disk },
      { target: { checkout, path: 'b.txt' }, disk, text: 'dirty b' },
    ]);
    const snapshot = (await load(client)).state;
    const input = {
      clientId: 'alice',
      requestId: 'a',
      target,
      expectedVersion: disk.version,
      text: 'pending a',
    };
    await assert.rejects(client.command('saveFile', input), isError('Uncertain'));
    const lock = new DatabaseSync(join(f.base, 'state/moonbase-workspace-v1.sqlite'));
    try {
      lock.exec('BEGIN IMMEDIATE');
      // A load while the store is locked still reads the recovery as it was.
      assert.deepEqual((await load(client)).state, snapshot);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    const saving = client.command('saveFile', {
      clientId: 'alice',
      requestId: 'b',
      target: { checkout, path: 'b.txt' },
      expectedVersion: disk.version,
      text: 'saved b',
    });
    await waitFor(ready);
    await assert.rejects(client.command('saveFile', input), isError('Persistence'));
    const during = await load(client);
    assert.deepEqual(during.state, snapshot);
    writeFileSync(release, 'continue');
    assert.equal((await saving).kind, 'saved');
    assert.equal((await client.command('saveFile', input)).kind, 'conflict');
    const after = await load(client);
    assert.equal(
      draftsOf(after.state).find((d) => d.target.path === 'file.txt')?.text,
      'pending a',
    );
    assert.equal(readFileSync(count, 'utf8'), 'file.txt\nb.txt\n');
  } finally {
    writeFileSync(release, 'continue');
    await runtime.dispose();
    f.cleanup();
  }
});

for (const lost of ['stage', 'replace'] as const)
  test(`current public producer cannot restore over an edit made during Save preflight; lost ${lost}`, async () => {
    const f = fixture(),
      enabled = join(f.base, 'enabled'),
      ready = join(f.base, 'ready'),
      release = join(f.base, 'release'),
      count = join(f.base, 'effects');
    const helper =
      f.wrapper(`if [ "$1" = read ] && [ "$2" = file.txt ] && [ -e ${quote(enabled)} ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi
if [ "$1" = stage ] && [ "$2" = file.txt ] && [ ${lost} = stage ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi
if [ "$1" = replace ]; then printf 'replace\\n' >> ${quote(count)}; if [ "$2" = file.txt ] && [ ${lost} = replace ]; then ${quote(binary)} "$@" || exit $?; kill -KILL $$; fi; fi`);
    let current = f.start(helper);
    try {
      writeFileSync(join(f.root, 'b.txt'), 'original');
      const checkout = await current.client.command('openCheckout', { root: f.root }),
        target = { checkout, path: 'file.txt' },
        disk = await current.client.command('readFile', target);
      const seeded = [
        { target, text: 'older draft', disk },
        { target: { checkout, path: 'b.txt' }, disk, text: 'older b' },
      ];
      await seed(current.client, 'alice', seeded);
      writeFileSync(enabled, 'pause');
      const input = {
        clientId: 'alice',
        requestId: 'old-preflight',
        target,
        expectedVersion: disk.version,
        text: 'earlier captured text',
      };
      const saving = current.client.command('saveFile', input);
      await waitFor(ready);
      await retype(current.client, seeded, (d) => 'later explicit ' + d.target.path);
      writeFileSync(release, 'continue');
      await assert.rejects(saving, isError('Uncertain'));
      if (lost === 'stage') writeFileSync(join(f.root, 'file.txt'), 'external');
      const actual = await current.client.command('readFile', target);
      const saved = await assertOnePublication(f.base, () =>
        current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'b',
          target: { checkout, path: 'b.txt' },
          expectedVersion: disk.version,
          text: 'saved b',
        }),
      );
      assert(saved.kind === 'saved');
      // b's save moved its baseline; a lost replace left file.txt's text on disk.
      const fileDisk = lost === 'replace' ? actual : disk;
      const expected = seeded.map((d) => ({
        ...d,
        text: 'later explicit ' + d.target.path,
        disk: d.target.path === 'b.txt' ? saved.disk : fileDisk,
      }));
      for (let restart = 0; restart < 2; restart++) {
        await current.runtime.dispose();
        current = f.start();
        assert.deepEqual(draftsOf((await load(current.client)).state), expected);
        // The host settled the interrupted save from the disk: its text never landed.
        const replay = await current.client.command('saveFile', input);
        assert.equal(replay.kind, lost === 'stage' ? 'conflict' : 'saved');
        assert.deepEqual(replay.disk, actual);
        await assert.rejects(
          current.client.command('saveFile', { ...input, text: 'changed payload' }),
          isError('Conflict'),
        );
      }
      assert.equal(
        readFileSync(count, 'utf8'),
        lost === 'stage' ? 'interrupted\nreplace\n' : 'replace\nreplace\n',
      );
      assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), actual.text);
    } finally {
      writeFileSync(release, 'continue');
      await current.runtime.dispose();
      f.cleanup();
    }
  });
