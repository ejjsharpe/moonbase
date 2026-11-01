import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyRecovery, type EditorRecovery } from '@moonbase/application/client';
import { WorkspaceLive } from '../src/index.ts';
import { binary, quote, fixture, isError, state, waitFor } from './recovery-fixture.ts';
test('concurrent lost-move reconciliation retains the original revision receipt and acknowledgement bounds', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  const helper = f.wrapper(
    `if [ "$1" = move ]; then printf 'effect\\n' >> ${quote(count)}; ${quote(binary)} "$@" || exit $?; kill -KILL $$; fi`,
  );
  let current = f.start(helper);
  try {
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      disk = await current.client.command('readFile', { checkout, path: 'file.txt' });
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: state(checkout, disk),
    });
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
    await Promise.all([
      current.client.command('operationStatus', { clientId: 'alice', id: 'lost' }),
      current.client.command('loadRecovery', { clientId: 'alice' }),
    ]);
    const receipt = await current.client.command('operationStatus', {
      clientId: 'alice',
      id: 'lost',
    });
    assert.deepEqual(receipt?.recoveryChanges, [
      { clientId: 'alice', previousRevision: 1, revision: 2 },
    ]);
    const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 2,
      state: loaded.state,
    });
    await current.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'alice',
      id: 'lost',
    });
    assert.deepEqual(
      (await current.client.command('operationStatus', { clientId: 'alice', id: 'lost' }))
        ?.recoveryChanges,
      receipt?.recoveryChanges,
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
    const snapshot = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      drafts: Array.from({ length: 257 }, (_, i) => ({
        target: { checkout, path: 'folder/' + i },
        text: 'dirty-' + i,
        disk,
      })),
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
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
    const retained = await current.client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(retained.revision, 1);
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
      await current.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: state(checkout, disk),
      });
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
      if (competing)
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 1,
          state: state(checkout, disk, 'later competing text'),
        });
      writeFileSync(join(f.root, 'file.txt'), 'external bytes');
      await current.runtime.dispose();
      current = f.start();
      const restored = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(
        restored.state.drafts[0].text,
        competing ? 'later competing text' : 'newest admitted text',
      );
      assert.deepEqual(restored.state.drafts[0].disk, competing ? disk : admittedBaseline);
      assert(restored.errors.some((e) => e.includes('Uncertain save')));
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
      const snapshot: EditorRecovery = {
        ...state(checkout, disk),
        openCheckoutIds: [],
        recentFiles: [{ checkout, path: 'file.txt' }],
        views: {
          [checkout.checkoutId]: {
            openFiles: ['file.txt'],
            active: 'file.txt',
            preview: null,
            fileViews: { 'file.txt': 'file' },
            positions: {},
            tree: { expanded: [], selected: [], focus: '', scroll: 0, hideIgnored: false },
          },
        },
      };
      await current.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: snapshot,
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
      const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert(!existsSync(count));
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.state.checkouts, [checkout]);
      assert.deepEqual(loaded.state.openCheckoutIds, []);
      assert.equal(
        loaded.state.views[checkout.checkoutId].active,
        kind === 'move' ? 'moved.txt' : 'file.txt',
      );
      assert.equal(loaded.state.recentFiles[0].path, kind === 'move' ? 'moved.txt' : 'file.txt');
      assert(loaded.state.drafts.some((d) => d.target.path === 'moved.txt'));
      for (const d of loaded.state.drafts) assert.deepEqual(d.disk, disk);
      for (const invalid of [
        { ...loaded.state, openCheckoutIds: [checkout.checkoutId, checkout.checkoutId] },
        { ...loaded.state, openCheckoutIds: ['unknown'] },
        { ...loaded.state, selectedCheckoutId: checkout.checkoutId },
        {
          ...loaded.state,
          views: { 'composite checkout key': loaded.state.views[checkout.checkoutId] },
        },
      ])
        await assert.rejects(
          current.client.command('persistRecovery', {
            requestId: randomUUID(),
            clientId: 'alice',
            expectedRevision: loaded.revision,
            state: invalid,
          }),
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
      const snapshot = {
        ...emptyRecovery('alice'),
        checkouts: [checkout],
        openCheckoutIds: [checkout.checkoutId],
        drafts,
      };
      await current.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: snapshot,
      });
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
      if (competing)
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 1,
          state: {
            ...snapshot,
            drafts: drafts.map((d) => ({ ...d, text: 'later ' + d.target.path })),
          },
        });
      if (!competing)
        for (const { target } of drafts)
          writeFileSync(join(f.root, target.path), 'external ' + target.path);
      for (let restart = 0; restart < 2; restart++) {
        await current.runtime.dispose();
        current = f.start();
        const loads = await Promise.all([
          current.client.command('loadRecovery', { clientId: 'alice' }),
          current.client.command('loadRecovery', { clientId: 'alice' }),
        ]);
        for (const loaded of loads) {
          assert.equal(loaded.revision, 2);
          assert.deepEqual(
            loaded.state.drafts.map((d) => d.text),
            ['a.txt', 'b.txt'].map((p) => (competing ? 'later ' : 'admitted ') + p),
          );
          assert.deepEqual(
            loaded.state.drafts.map((d) => d.disk),
            drafts.map((d) => d.disk),
          );
          assert(
            loaded.errors.some((e) => e.includes('a.txt')) &&
              loaded.errors.some((e) => e.includes('b.txt')),
          );
        }
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
    const snapshot = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      drafts: Array.from({ length: 511 }, (_, i) => ({
        target: { checkout, path: 'old/' + i },
        text: 'old ' + i,
        disk,
      })),
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
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
      const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(loaded.revision, 1);
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
    const snapshot = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      drafts: ['a.txt', 'b.txt'].map((path) => ({
        target: { checkout, path },
        disk,
        text: 'old ' + path,
      })),
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
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
    const later = {
      ...snapshot,
      drafts: snapshot.drafts.map((d) => ({ ...d, text: 'later ' + d.target.path })),
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 1,
      state: later,
    });
    writeFileSync(release, 'continue');
    const loaded = await loading;
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.state, later);
    assert.equal(loaded.errors.length, 2);
  } finally {
    writeFileSync(release, 'continue');
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('grouped Save publisher preserves visible persistence failure and clears pending on a non-replaying retry', async () => {
  const { DatabaseSync } = await import('node:sqlite');
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
    await client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: state(checkout, disk, 'saved text'),
    });
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
    const result = await client.command('saveFile', input);
    assert.equal(result.kind, 'saved');
    assert(result.kind === 'saved' && !result.persistencePending);
    assert.deepEqual(result.kind === 'saved' && result.recoveryChanges, [
      { clientId: 'alice', previousRevision: 1, revision: 2 },
    ]);
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
    const snapshot = {
      ...emptyRecovery('alice'),
      checkouts: [checkout],
      openCheckoutIds: [checkout.checkoutId],
      drafts: Array.from({ length: 511 }, (_, i) => ({
        target: { checkout, path: 'old/' + i },
        text: 'old ' + i,
        disk,
      })),
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
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
      const before = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(before.revision, 1);
      assert.deepEqual(before.state, snapshot);
      const retries = await Promise.allSettled(
        inputs.map((input) => current.client.command('saveFile', input)),
      );
      assert(
        retries.every((r) => r.status === 'rejected' && isError('Persistence')(r.reason)),
        'Every retry must preserve the complete rejected group and report its persistence failure.',
      );
      const after = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(after.revision, 1);
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
    test(`unrelated ${sibling} ${competing ? 'does not weaken a later client publication fence' : 'preserves pending interrupted text across internal revisions'}`, async () => {
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
        const snapshot = {
          ...emptyRecovery('alice'),
          checkouts: [checkout],
          openCheckoutIds: [checkout.checkoutId],
          drafts,
        };
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 0,
          state: snapshot,
        });
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
          const result = await current.client.command('saveFile', {
            clientId: 'alice',
            requestId: 'b',
            target: drafts[1].target,
            expectedVersion: drafts[1].disk.version,
            text: 'saved b',
          });
          assert.equal(result.kind, 'saved');
          assert.deepEqual(result.kind === 'saved' && result.recoveryChanges, [
            { clientId: 'alice', previousRevision: 1, revision: 2 },
          ]);
        } else {
          const sources = await current.client.command('inspectEntries', {
            checkout,
            paths: ['b.txt'],
          });
          const result = await current.client.command('mutate', {
            clientId: 'alice',
            id: 'b',
            checkout,
            kind: 'move',
            sources,
            destination: 'moved-b.txt',
          });
          assert.equal(result.outcome, 'completed');
          assert.deepEqual(result.recoveryChanges, [
            { clientId: 'alice', previousRevision: 1, revision: 2 },
          ]);
        }
        if (competing)
          await current.client.command('persistRecovery', {
            requestId: randomUUID(),
            clientId: 'alice',
            expectedRevision: 2,
            state: {
              ...snapshot,
              drafts: drafts.map((d) => ({ ...d, text: 'later ' + d.target.path })),
            },
          });
        for (let restart = 0; restart < 2; restart++) {
          await current.runtime.dispose();
          current = f.start();
          const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
          assert.equal(loaded.revision, 3);
          assert.equal(
            loaded.state.drafts.find((d) => d.target.path === 'a.txt')?.text,
            competing ? 'later a.txt' : 'admitted a',
          );
          assert.deepEqual(
            loaded.state.drafts.find((d) => d.target.path === 'a.txt')?.disk,
            drafts[0].disk,
          );
          if (!competing) {
            const b = loaded.state.drafts.find(
              (d) => d.target.path === (sibling === 'move' ? 'moved-b.txt' : 'b.txt'),
            );
            assert(b);
            assert.equal(b.text, 'old b.txt');
            assert.equal(b.disk.text, sibling === 'save' ? 'saved b' : 'original');
          }
          assert.equal(loaded.errors.length, 1);
          await assert.rejects(
            current.client.command('persistRecovery', {
              requestId: randomUUID(),
              clientId: 'alice',
              expectedRevision: 1,
              state: snapshot,
            }),
            isError('Conflict'),
          );
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

test('a genuine client publication during Save preflight fences later interrupted admission', async () => {
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
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: state(checkout, disk),
    });
    writeFileSync(pause, 'pause');
    const saving = current.client.command('saveFile', {
      clientId: 'alice',
      requestId: 'preflight',
      target,
      expectedVersion: disk.version,
      text: 'admitted before publication',
    });
    await waitFor(ready);
    const later = state(checkout, disk, 'newer client publication');
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 1,
      state: later,
    });
    writeFileSync(release, 'continue');
    await assert.rejects(saving, isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    await current.runtime.dispose();
    current = f.start();
    const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.state, later);
    assert.equal(loaded.errors.length, 1);
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
    await client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: state(checkout, disk),
    });
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
    assert.equal(
      (await client.command('loadRecovery', { clientId: 'alice' })).state.drafts[0].text,
      'pending text',
    );
  } finally {
    await runtime.dispose();
    f.cleanup();
  }
});

for (const sibling of ['save', 'move'] as const)
  test(`pending text survives a failed ${sibling} fact publication and its non-replaying retry`, async () => {
    const { DatabaseSync } = await import('node:sqlite');
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
      const snapshot = {
        ...state(checkout, disk),
        drafts: [
          ...state(checkout, disk).drafts,
          { target: { checkout, path: 'b.txt' }, disk, text: 'dirty b' },
        ],
      };
      await current.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId: 'alice',
        expectedRevision: 0,
        state: snapshot,
      });
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
      const retried =
        sibling === 'save'
          ? await current.client.command('saveFile', saveInput)
          : await current.client.command('mutate', moveInput);
      assert.deepEqual('recoveryChanges' in retried && retried.recoveryChanges, [
        { clientId: 'alice', previousRevision: 1, revision: 2 },
      ]);
      for (let restart = 0; restart < 2; restart++) {
        await current.runtime.dispose();
        current = f.start();
        const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
        assert.equal(loaded.revision, 3);
        assert.equal(
          loaded.state.drafts.find((d) => d.target.path === 'file.txt')?.text,
          'pending a',
        );
        assert.equal(loaded.errors.length, 1);
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

test('foreign operation and restoration revisions do not acknowledge either observer without client publication', async () => {
  const f = fixture(),
    helper = f.wrapper('if [ "$1" = stage ]; then kill -KILL $$; fi');
  let current = f.start(helper);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await current.client.command('readFile', target);
    for (const clientId of ['alice', 'bob'])
      await current.client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId,
        expectedRevision: 0,
        state: {
          ...state(checkout, disk),
          clientId,
          drafts: [
            ...state(checkout, disk).drafts,
            { target: { checkout, path: 'b.txt' }, disk, text: clientId + ' dirty b' },
          ],
        },
      });
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
    const sources = await current.client.command('inspectEntries', { checkout, paths: ['b.txt'] });
    const moved = await current.client.command('mutate', {
      clientId: 'bob',
      id: 'move',
      checkout,
      kind: 'move',
      sources,
      destination: 'moved-b.txt',
    });
    assert.equal(moved.outcome, 'completed');
    await current.runtime.dispose();
    current = f.start();
    const loads = await Promise.all(
      ['alice', 'bob'].map((clientId) => current.client.command('loadRecovery', { clientId })),
    );
    assert.equal(
      loads[0].state.drafts.find((d) => d.target.path === 'file.txt')?.text,
      'pending a',
    );
    assert.equal(loads[0].revision, 3);
    assert.equal(loads[1].revision, 2);
    for (const clientId of ['alice', 'bob'])
      await assert.rejects(
        current.client.command('acknowledgeOperation', {
          clientId,
          operationClientId: 'bob',
          id: 'move',
        }),
        isError('Persistence'),
      );
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 3,
      state: loads[0].state,
    });
    await current.client.command('acknowledgeOperation', {
      clientId: 'alice',
      operationClientId: 'bob',
      id: 'move',
    });
    assert.equal(
      (await current.client.command('loadRecovery', { clientId: 'alice' })).operations.length,
      0,
    );
    assert.equal(
      (await current.client.command('loadRecovery', { clientId: 'bob' })).operations.length,
      1,
    );
    await assert.rejects(
      current.client.command('acknowledgeOperation', {
        clientId: 'bob',
        operationClientId: 'bob',
        id: 'move',
      }),
      isError('Persistence'),
    );
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'bob',
      expectedRevision: 2,
      state: loads[1].state,
    });
    await current.client.command('acknowledgeOperation', {
      clientId: 'bob',
      operationClientId: 'bob',
      id: 'move',
    });
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});

test('complete restoration retries wait for an active sibling admission without publishing part of its group', async () => {
  const { DatabaseSync } = await import('node:sqlite');
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
    const snapshot = {
      ...state(checkout, disk),
      drafts: [
        ...state(checkout, disk).drafts,
        { target: { checkout, path: 'b.txt' }, disk, text: 'dirty b' },
      ],
    };
    await client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
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
      assert.equal((await client.command('loadRecovery', { clientId: 'alice' })).revision, 1);
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
    const during = await client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(during.revision, 1);
    assert.deepEqual(during.state, snapshot);
    writeFileSync(release, 'continue');
    assert.equal((await saving).kind, 'saved');
    assert.equal((await client.command('saveFile', input)).kind, 'conflict');
    const after = await client.command('loadRecovery', { clientId: 'alice' });
    assert.equal(after.revision, 3);
    assert.equal(after.state.drafts[0].text, 'pending a');
    assert.equal(readFileSync(count, 'utf8'), 'file.txt\nb.txt\n');
  } finally {
    writeFileSync(release, 'continue');
    await runtime.dispose();
    f.cleanup();
  }
});

// Unmodified first-party module source, retained only to generate authentic previous-format test stores.
let previousModule: Promise<{ WorkspaceLive: typeof WorkspaceLive }> | undefined;
function previousWorkspace() {
  if (!previousModule) {
    const archive = fileURLToPath(new URL('./fixtures/workspace-53a0996.tar.gz', import.meta.url));
    assert.equal(
      createHash('sha256').update(readFileSync(archive)).digest('hex'),
      '4b9e54649f195a18e8d93502f86bf21ba12e070c10261aa47a61d6f6b8aa510b',
    );
    const directory = fileURLToPath(new URL('../dist/previous-workspace', import.meta.url));
    mkdirSync(directory, { recursive: true });
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', directory]);
    previousModule = import(pathToFileURL(join(directory, 'index.ts')).href);
  }
  return previousModule!;
}

for (const previous of [true, false])
  for (const lost of ['stage', 'replace'] as const)
    test(`${previous ? 'previous' : 'current'} public producer cannot restore over a publication made during Save preflight; lost ${lost}`, async () => {
      const live = previous ? (await previousWorkspace()).WorkspaceLive : WorkspaceLive;
      const f = fixture(),
        enabled = join(f.base, 'enabled'),
        ready = join(f.base, 'ready'),
        release = join(f.base, 'release'),
        count = join(f.base, 'effects');
      const helper =
        f.wrapper(`if [ "$1" = read ] && [ "$2" = file.txt ] && [ -e ${quote(enabled)} ]; then /usr/bin/touch ${quote(ready)}; while [ ! -e ${quote(release)} ]; do /bin/sleep 0.01; done; fi
if [ "$1" = stage ] && [ "$2" = file.txt ] && [ ${lost} = stage ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi
if [ "$1" = replace ]; then printf 'replace\\n' >> ${quote(count)}; if [ "$2" = file.txt ] && [ ${lost} = replace ]; then ${quote(binary)} "$@" || exit $?; kill -KILL $$; fi; fi`);
      let current = f.start(helper, live);
      try {
        writeFileSync(join(f.root, 'b.txt'), 'original');
        const checkout = await current.client.command('openCheckout', { root: f.root }),
          target = { checkout, path: 'file.txt' },
          disk = await current.client.command('readFile', target);
        const snapshot = {
          ...state(checkout, disk),
          drafts: [
            ...state(checkout, disk).drafts,
            { target: { checkout, path: 'b.txt' }, disk, text: 'older b' },
          ],
        };
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 0,
          state: snapshot,
        });
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
        const later = {
          ...snapshot,
          drafts: snapshot.drafts.map((d) => ({ ...d, text: 'later explicit ' + d.target.path })),
        };
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: 1,
          state: later,
        });
        writeFileSync(release, 'continue');
        await assert.rejects(saving, isError('Uncertain'));
        if (lost === 'stage') writeFileSync(join(f.root, 'file.txt'), 'external');
        const actual = await current.client.command('readFile', target);
        const saved = await current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'b',
          target: { checkout, path: 'b.txt' },
          expectedVersion: disk.version,
          text: 'saved b',
        });
        assert.equal(saved.kind, 'saved');
        assert.deepEqual(saved.kind === 'saved' && saved.recoveryChanges, [
          { clientId: 'alice', previousRevision: 2, revision: 3 },
        ]);
        assert(saved.kind === 'saved');
        const expected = {
          ...later,
          drafts: later.drafts.map((d) => {
            if (d.target.path === 'b.txt') return { ...d, disk: saved.disk };
            if (!previous && lost === 'replace') return { ...d, disk: actual };
            return d;
          }),
        };
        for (let restart = 0; restart < 2; restart++) {
          await current.runtime.dispose();
          current = f.start();
          const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
          assert.equal(loaded.revision, !previous && lost === 'replace' ? 4 : 3);
          assert.deepEqual(loaded.state, expected);
          assert.equal(loaded.errors.length, 1);
          if (previous)
            assert.match(
              loaded.errors[0],
              /publication fence.*unknown|unknown.*publication fence/i,
            );
          if (lost === 'stage')
            await assert.rejects(current.client.command('saveFile', input), isError('Uncertain'));
          else {
            const replay = await current.client.command('saveFile', input);
            assert.equal(replay.kind, 'saved');
            assert.deepEqual(replay.kind === 'saved' && replay.disk, actual);
          }
          await assert.rejects(
            current.client.command('saveFile', { ...input, text: 'changed payload' }),
            isError('Conflict'),
          );
          await assert.rejects(
            current.client.command('persistRecovery', {
              requestId: randomUUID(),
              clientId: 'alice',
              expectedRevision: 2,
              state: expected,
            }),
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

for (const previous of [true, false])
  for (const internal of ['none', 'save', 'move'] as const)
    test(`${previous ? 'missing' : 'current'} publication metadata and internal ${internal} cannot authorize observer acknowledgement`, async () => {
      const live = previous ? (await previousWorkspace()).WorkspaceLive : WorkspaceLive;
      const f = fixture(),
        count = join(f.base, 'effects'),
        helper = f.wrapper(
          `if [ "$1" = replace ] || [ "$1" = move ]; then printf '%s\\n' "$1" >> ${quote(count)}; fi`,
        );
      let current = f.start(helper, live);
      try {
        for (const path of ['b.txt', 'c.txt']) writeFileSync(join(f.root, path), 'original');
        const checkout = await current.client.command('openCheckout', { root: f.root }),
          disk = await current.client.command('readFile', { checkout, path: 'file.txt' });
        const snapshot = {
          ...state(checkout, disk),
          drafts: ['file.txt', 'b.txt', 'c.txt'].map((path) => ({
            target: { checkout, path },
            disk,
            text: 'dirty ' + path,
          })),
        };
        for (const clientId of ['alice', 'bob'])
          await current.client.command('persistRecovery', {
            requestId: randomUUID(),
            clientId,
            expectedRevision: 0,
            state: { ...snapshot, clientId },
          });
        const input = {
          clientId: 'bob',
          id: 'foreign',
          checkout,
          kind: 'move' as const,
          sources: await current.client.command('inspectEntries', {
            checkout,
            paths: ['file.txt'],
          }),
          destination: 'moved.txt',
        };
        const moved = await current.client.command('mutate', input);
        assert.equal(moved.outcome, 'completed');
        const saved = await current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'b',
          target: { checkout, path: 'b.txt' },
          expectedVersion: disk.version,
          text: 'saved b',
        });
        assert.deepEqual(saved.kind === 'saved' && saved.recoveryChanges, [
          { clientId: 'alice', previousRevision: 2, revision: 3 },
        ]);
        await current.runtime.dispose();
        current = f.start(helper);
        if (internal === 'save')
          assert.equal(
            (
              await current.client.command('saveFile', {
                clientId: 'alice',
                requestId: 'c',
                target: { checkout, path: 'c.txt' },
                expectedVersion: disk.version,
                text: 'saved c',
              })
            ).kind,
            'saved',
          );
        if (internal === 'move')
          assert.equal(
            (
              await current.client.command('mutate', {
                clientId: 'bob',
                id: 'current-move',
                checkout,
                kind: 'move',
                sources: await current.client.command('inspectEntries', {
                  checkout,
                  paths: ['c.txt'],
                }),
                destination: 'moved-c.txt',
              })
            ).outcome,
            'completed',
          );
        for (let restart = 0; restart < 2; restart++) {
          const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
          assert.equal(loaded.revision, internal === 'none' ? 3 : 4);
          assert(loaded.operations.some((o) => o.id === 'foreign'));
          await assert.rejects(
            current.client.command('acknowledgeOperation', {
              clientId: 'alice',
              operationClientId: 'bob',
              id: 'foreign',
            }),
            isError('Persistence'),
          );
          await assert.rejects(
            current.client.command('acknowledgeOperation', {
              clientId: 'bob',
              operationClientId: 'bob',
              id: 'foreign',
            }),
            isError('Persistence'),
          );
          assert.deepEqual(
            (await current.client.command('operationStatus', { clientId: 'bob', id: 'foreign' }))
              ?.recoveryChanges,
            moved.recoveryChanges,
          );
          await current.runtime.dispose();
          current = f.start();
        }
        const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
        await current.client.command('persistRecovery', {
          requestId: randomUUID(),
          clientId: 'alice',
          expectedRevision: loaded.revision,
          state: loaded.state,
        });
        await current.client.command('acknowledgeOperation', {
          clientId: 'alice',
          operationClientId: 'bob',
          id: 'foreign',
        });
        await current.runtime.dispose();
        current = f.start();
        assert(
          !(await current.client.command('loadRecovery', { clientId: 'alice' })).operations.some(
            (o) => o.id === 'foreign',
          ),
        );
        assert(
          (await current.client.command('loadRecovery', { clientId: 'bob' })).operations.some(
            (o) => o.id === 'foreign',
          ),
        );
        let effects = 'move\nreplace\n';
        if (internal === 'save') effects += 'replace\n';
        else if (internal !== 'none') effects += 'move\n';
        assert.equal(readFileSync(count, 'utf8'), effects);
      } finally {
        await current.runtime.dispose();
        f.cleanup();
      }
    });

test('current Save in a previous public store retains its zero fence across internal revisions', async () => {
  const f = fixture(),
    count = join(f.base, 'effects');
  let current = f.start(binary, (await previousWorkspace()).WorkspaceLive);
  const helper =
    f.wrapper(`if [ "$1" = stage ] && [ "$2" = file.txt ]; then printf 'interrupted\\n' >> ${quote(count)}; kill -KILL $$; fi
if [ "$1" = replace ]; then printf 'replace\\n' >> ${quote(count)}; fi`);
  try {
    writeFileSync(join(f.root, 'b.txt'), 'original');
    const checkout = await current.client.command('openCheckout', { root: f.root }),
      target = { checkout, path: 'file.txt' },
      disk = await current.client.command('readFile', target);
    const snapshot = {
      ...state(checkout, disk),
      drafts: [
        ...state(checkout, disk).drafts,
        { target: { checkout, path: 'b.txt' }, disk, text: 'older b' },
      ],
    };
    await current.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: 0,
      state: snapshot,
    });
    await current.runtime.dispose();
    current = f.start(helper);
    const input = {
      clientId: 'alice',
      requestId: 'current',
      target,
      expectedVersion: disk.version,
      text: 'current captured text',
    };
    await assert.rejects(current.client.command('saveFile', input), isError('Uncertain'));
    writeFileSync(join(f.root, 'file.txt'), 'external');
    assert.equal(
      (
        await current.client.command('saveFile', {
          clientId: 'alice',
          requestId: 'b',
          target: { checkout, path: 'b.txt' },
          expectedVersion: disk.version,
          text: 'saved b',
        })
      ).kind,
      'saved',
    );
    for (let restart = 0; restart < 2; restart++) {
      await current.runtime.dispose();
      current = f.start();
      const loaded = await current.client.command('loadRecovery', { clientId: 'alice' });
      assert.equal(loaded.revision, 3);
      assert.equal(loaded.state.drafts[0].text, 'current captured text');
      assert.deepEqual(loaded.state.drafts[0].disk, disk);
      assert.equal(loaded.errors.length, 1);
    }
    assert.equal(readFileSync(count, 'utf8'), 'interrupted\nreplace\n');
  } finally {
    await current.runtime.dispose();
    f.cleanup();
  }
});
