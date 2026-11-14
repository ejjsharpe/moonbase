import assert from 'node:assert/strict';
import { toWireError } from '@moonbase/contracts/workspace-host-errors';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { readInstallationId, WorkspaceRecoveryLive } from '../src/index.ts';
import { draft } from './workspace-fixture.ts';
import { dropReply, dropRequest, harness, lost, openCheckout } from './split-fixture.ts';
import { isError } from './recovery-fixture.ts';

test('a save whose reply is lost resolves through saveStatus, and one that never arrived returns as a draft over its baseline, even once another client moved that draft', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'original');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root),
      target = { checkout, path: 'file.txt' },
      disk = await Effect.runPromise(host.readFile(target));
    const save = (requestId: string, text: string, expectedVersion: string) => ({
      target,
      clientId: 'window',
      requestId,
      text,
      expectedVersion,
    });
    // The host commits, then the client gets an unusable reply (a malformed one here) and no status.
    const malformed = new ApplicationError({
      code: 'Incompatible',
      message: 'Malformed.',
    });
    let alice = h.startClient('alice', host, dropReply('saveFile', malformed));
    await alice.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'window',
      expectedRevision: 0,
      state: draft('window', checkout, 'committed text', disk),
    });
    await assert.rejects(
      alice.client.command('saveFile', save('lost-reply', 'committed text', disk.version)),
    );
    assert.equal(readFileSync(join(h.root, 'file.txt'), 'utf8'), 'committed text');
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    const resolved = await alice.client.command('loadRecovery', {
      clientId: 'window',
    });
    assert.equal(resolved.state.drafts[0].disk.text, 'committed text');
    assert.deepEqual(resolved.errors, []);
    assert.equal(
      (
        await Effect.runPromise(
          host.saveStatus({
            installationId: 'alice',
            clientId: 'window',
            requestId: 'lost-reply',
          }),
        )
      ).kind,
      'saved',
    );
    // The request never reaches the host: its text comes back as a draft over the old baseline.
    await alice.runtime.dispose();
    alice = h.startClient('alice', host, dropRequest('saveFile'));
    await assert.rejects(
      alice.client.command(
        'saveFile',
        save('never-arrived', 'unsent text', resolved.state.drafts[0].disk.version),
      ),
    );
    await alice.runtime.dispose();
    // Meanwhile another installation moves the file, and the feed moves the draft whose baseline
    // the save began from (the save kept only its version).
    const bob = h.startClient('bob', host);
    await bob.client.command('mutate', {
      id: 'move',
      clientId: 'b',
      checkout,
      kind: 'move',
      sources: await bob.client.command('inspectEntries', { checkout, paths: ['file.txt'] }),
      destination: 'moved.txt',
    });
    alice = h.startClient('alice', host);
    const restored = await alice.client.command('loadRecovery', {
      clientId: 'window',
    });
    assert.deepEqual(
      restored.state.drafts.map((d) => [d.target.path, d.text, d.disk.text]).sort(),
      [
        ['file.txt', 'unsent text', 'committed text'],
        ['moved.txt', 'committed text', 'committed text'],
      ],
    );
    // The host told the client `not-started`, so a delayed copy of that request never runs.
    const late = await Effect.runPromise(
      Effect.flip(
        host.saveFile({
          installationId: 'alice',
          ...save('never-arrived', 'unsent text', resolved.state.drafts[0].disk.version),
        }),
      ),
    );
    assert.equal(toWireError(late).code, 'Conflict');
    assert(!existsSync(join(h.root, 'file.txt')));
  } finally {
    await h.close();
  }
});

test('a save whose baseline another save of the file replaced in the recovery still returns as a draft over it', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'original');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root),
      target = { checkout, path: 'file.txt' },
      disk = await Effect.runPromise(host.readFile(target));
    const save = (requestId: string, text: string) => ({
      target,
      clientId: 'window',
      requestId,
      text,
      expectedVersion: disk.version,
    });
    // The second save reaches the host only after the first has settled, and its reply is lost.
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => (arrive = resolve)),
      released = new Promise<void>((resolve) => (release = resolve));
    let alice = h.startClient('alice', host, (inner) => ({
      ...inner,
      saveFile: (input) =>
        input.requestId === 'second'
          ? Effect.promise(() => (arrive(), released)).pipe(
              Effect.andThen(inner.saveFile(input)),
              Effect.andThen(Effect.fail(lost)),
            )
          : inner.saveFile(input),
      saveStatus: () => Effect.fail(lost),
    }));
    await alice.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'window',
      expectedRevision: 0,
      state: draft('window', checkout, 'first text', disk),
    });
    const second = alice.client.command('saveFile', save('second', 'second text'));
    await arrived;
    assert.equal(
      (await alice.client.command('saveFile', save('first', 'first text'))).kind,
      'saved',
    );
    release();
    await assert.rejects(second);
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    const loaded = await alice.client.command('loadRecovery', { clientId: 'window' });
    // The host refused the second save as a conflict: its text comes back over its own baseline.
    assert.deepEqual(
      loaded.state.drafts.map((d) => [d.text, d.disk.text]),
      [['second text', 'original']],
    );
    assert.equal(readFileSync(join(h.root, 'file.txt'), 'utf8'), 'first text');
  } finally {
    await h.close();
  }
});

test('a move whose reply is lost before publication resolves through operationStatus after a restart', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'disk');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root),
      disk = await Effect.runPromise(host.readFile({ checkout, path: 'file.txt' }));
    let alice = h.startClient('alice', host, dropReply('mutate'));
    await alice.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'window',
      expectedRevision: 0,
      state: draft('window', checkout, 'dirty', disk),
    });
    const sources = await alice.client.command('inspectEntries', {
      checkout,
      paths: ['file.txt'],
    });
    const move = {
      id: 'lost-move',
      clientId: 'window',
      checkout,
      kind: 'move' as const,
      sources,
      destination: 'moved.txt',
    };
    await assert.rejects(alice.client.command('mutate', move));
    assert(existsSync(join(h.root, 'moved.txt')));
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    const status = await alice.client.command('operationStatus', {
      clientId: 'window',
      id: 'lost-move',
    });
    assert.equal(status?.outcome, 'completed');
    const loaded = await alice.client.command('loadRecovery', {
      clientId: 'window',
    });
    assert.equal(loaded.state.drafts[0].target.path, 'moved.txt');
    assert.equal(loaded.state.drafts[0].text, 'dirty');
    // A move left without any answer, which never reached the host: a repeat finds it never ran
    // (its ID is now retired there), drops the intent and is refused, never sent again.
    writeFileSync(join(h.root, 'other.txt'), 'other');
    await alice.runtime.dispose();
    alice = h.startClient('alice', host, (inner) => ({
      ...inner,
      mutate: () => Effect.fail(lost),
      operationStatus: () => Effect.fail(lost),
    }));
    const unsent = {
      ...move,
      id: 'unsent',
      sources: await alice.client.command('inspectEntries', { checkout, paths: ['other.txt'] }),
      destination: 'unsent.txt',
    };
    await assert.rejects(alice.client.command('mutate', unsent));
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    await assert.rejects(alice.client.command('mutate', unsent), (error: unknown) =>
      isError('Conflict')(error),
    );
    assert(!existsSync(join(h.root, 'unsent.txt')));
    assert.equal(
      await alice.client.command('operationStatus', { clientId: 'window', id: 'unsent' }),
      null,
    );
    const again = await alice.client.command('mutate', { ...unsent, id: 'unsent-again' });
    assert.equal(again.outcome, 'completed');
  } finally {
    await h.close();
  }
});

test("one client's move re-paths another client's draft on its next load, even its first, and its Trash leaves the draft", async () => {
  const h = harness();
  let trashed = '';
  try {
    writeFileSync(join(h.root, 'moves.txt'), 'm');
    writeFileSync(join(h.root, 'trashed.txt'), 't');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root);
    const read = (path: string) => Effect.runPromise(host.readFile({ checkout, path }));
    const alice = h.startClient('alice', host),
      bob = h.startClient('bob', host);
    const persist = (
      client: typeof alice.client,
      clientId: string,
      state: ReturnType<typeof draft>,
    ) =>
      client.command('persistRecovery', {
        requestId: randomUUID(),
        clientId,
        expectedRevision: 0,
        state,
      });
    await persist(alice.client, 'a', draft('a', checkout, 'alice', await read('moves.txt')));
    const moving = {
      target: { checkout, path: 'moves.txt' },
      text: 'bob moves',
      disk: await read('moves.txt'),
    };
    const trashing = {
      target: { checkout, path: 'trashed.txt' },
      text: 'bob stays',
      disk: await read('trashed.txt'),
    };
    await persist(bob.client, 'b', {
      ...draft('b', checkout, '', moving.disk),
      drafts: [moving, trashing],
    });
    // Bob has not loaded since adding the checkout: its feed is followed from when it was added.
    const run = async (id: string, kind: 'move' | 'trash', path: string, destination?: string) =>
      alice.client.command('mutate', {
        id,
        clientId: 'a',
        checkout,
        kind,
        sources: await alice.client.command('inspectEntries', {
          checkout,
          paths: [path],
        }),
        ...(destination ? { destination } : {}),
      });
    await run('move', 'move', 'moves.txt', 'renamed.txt');
    const trash = await run('trash', 'trash', 'trashed.txt');
    trashed = trash.items[0].message!.replace('macOS Trash: ', '');
    const loaded = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.deepEqual(loaded.state.drafts.map((d) => [d.target.path, d.text]).sort(), [
      ['renamed.txt', 'bob moves'],
      ['trashed.txt', 'bob stays'],
    ]);
    assert.deepEqual(
      loaded.operations.map((o) => o.clientId),
      ['a', 'a'],
    );
    // Applied once: a later load finds nothing new to reconcile.
    const again = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.equal(again.revision, loaded.revision);
  } finally {
    if (trashed.includes('/.Trash/') && existsSync(trashed)) rmSync(trashed);
    await h.close();
  }
});

test('a checkout the host refuses does not stop the feed for the others', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'disk');
    const { host } = await h.startHost();
    mkdirSync(join(h.base, 'other'));
    const checkout = await openCheckout(host, h.root),
      stale = await openCheckout(host, join(h.base, 'other'));
    const disk = await Effect.runPromise(host.readFile({ checkout, path: 'file.txt' }));
    const alice = h.startClient('alice', host),
      bob = h.startClient('bob', host, (inner) => ({
        ...inner,
        listOperations: (input) =>
          input.checkout.checkoutId === stale.checkoutId
            ? Effect.fail(
                new ApplicationError({
                  code: 'Unauthorized',
                  message: 'Replaced.',
                }),
              )
            : inner.listOperations(input),
      }));
    await bob.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'b',
      expectedRevision: 0,
      state: {
        ...draft('b', checkout, 'bob', disk),
        checkouts: [checkout, stale],
      },
    });
    await bob.client.command('loadRecovery', { clientId: 'b' });
    await alice.client.command('mutate', {
      id: 'move',
      clientId: 'a',
      checkout,
      kind: 'move',
      sources: await alice.client.command('inspectEntries', {
        checkout,
        paths: ['file.txt'],
      }),
      destination: 'renamed.txt',
    });
    const loaded = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.equal(loaded.state.drafts[0].target.path, 'renamed.txt');
    assert(loaded.errors.length > 0);
  } finally {
    await h.close();
  }
});

test("a checkout's failed listing is retried later, and a move onto a drafted path keeps both drafts without stopping the feed", async () => {
  const h = harness();
  try {
    for (const path of ['a.txt', 'c.txt']) writeFileSync(join(h.root, path), path);
    const { host } = await h.startHost();
    mkdirSync(join(h.base, 'other'));
    const checkout = await openCheckout(host, h.root),
      other = await openCheckout(host, join(h.base, 'other'));
    const read = (path: string) => Effect.runPromise(host.readFile({ checkout, path }));
    let failing = false;
    const alice = h.startClient('alice', host),
      bob = h.startClient('bob', host, (inner) => ({
        ...inner,
        listOperations: (input) =>
          failing && input.checkout.checkoutId === checkout.checkoutId
            ? Effect.fail(lost)
            : inner.listOperations(input),
      }));
    const a = await read('a.txt'),
      c = await read('c.txt');
    await bob.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'b',
      expectedRevision: 0,
      state: {
        ...draft('b', checkout, '', a),
        checkouts: [checkout, other],
        drafts: [
          { target: { checkout, path: 'a.txt' }, text: 'bob a', disk: a },
          // A draft of a file not on disk (yet): a move may land there.
          { target: { checkout, path: 'b.txt' }, text: 'bob b', disk: a },
          { target: { checkout, path: 'c.txt' }, text: 'bob c', disk: c },
        ],
      },
    });
    const move = async (id: string, path: string, destination: string) =>
      alice.client.command('mutate', {
        id,
        clientId: 'a',
        checkout,
        kind: 'move',
        sources: await alice.client.command('inspectEntries', { checkout, paths: [path] }),
        destination,
      });
    await move('onto-draft', 'a.txt', 'b.txt');
    await move('later', 'c.txt', 'd.txt');
    const paths = (state: { drafts: { target: { path: string }; text: string }[] }) =>
      state.drafts.map((d) => [d.target.path, d.text]).sort();
    // The checkout's listing fails while the other's succeeds: nothing is skipped or marked.
    failing = true;
    const failed = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.deepEqual(paths(failed.state), [
      ['a.txt', 'bob a'],
      ['b.txt', 'bob b'],
      ['c.txt', 'bob c'],
    ]);
    assert(failed.errors.some((e) => e.includes('history unavailable')));
    assert(!failed.errors.some((e) => e.includes('incomplete')));
    failing = false;
    const loaded = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.deepEqual(paths(loaded.state), [
      ['a.txt', 'bob a'],
      ['b.txt', 'bob b'],
      ['d.txt', 'bob c'],
    ]);
    assert(loaded.errors.some((e) => e.includes('incomplete')));
  } finally {
    await h.close();
  }
});

test('journal entries leave after acknowledgement and the window; a feed gap keeps drafts and marks them', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'disk');
    let { host, runtime } = await h.startHost(5_000);
    const checkout = await openCheckout(host, h.root),
      disk = await Effect.runPromise(host.readFile({ checkout, path: 'file.txt' }));
    const move = async (id: string, from: string, destination: string) =>
      Effect.runPromise(
        host.mutate({
          installationId: 'alice',
          id,
          clientId: 'a',
          checkout,
          kind: 'move',
          sources: await Effect.runPromise(host.inspectEntries({ checkout, paths: [from] })),
          destination,
        }),
      );
    const acknowledge = (id: string) =>
      Effect.runPromise(
        host.acknowledgeOperation({
          installationId: 'alice',
          clientId: 'a',
          id,
        }),
      );
    const status = (id: string) =>
      Effect.runPromise(host.operationStatus({ installationId: 'alice', clientId: 'a', id }));
    let bob = h.startClient('bob', host);
    await bob.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'b',
      expectedRevision: 0,
      state: draft('b', checkout, 'bob draft', disk),
    });
    await bob.client.command('loadRecovery', { clientId: 'b' });
    await move('first', 'file.txt', 'moved.txt');
    await acknowledge('first');
    await move('second', 'moved.txt', 'back.txt');
    await acknowledge('second');
    await Effect.runPromise(
      host.mutate({
        installationId: 'alice',
        id: 'unacknowledged',
        clientId: 'a',
        checkout,
        kind: 'create-file',
        sources: [],
        destination: 'new.txt',
        text: '',
      }),
    );
    // `null` for an ID the host never saw is a promise: a mutation with it that arrives later
    // never runs, as the client has already discarded its intent.
    assert.equal(await status('overtaken'), null);
    await assert.rejects(move('overtaken', 'back.txt', 'overtaken.txt'), (error: unknown) =>
      isError('Conflict')(error),
    );
    assert(existsSync(join(h.root, 'back.txt')));
    // Within the window an acknowledged entry is still replayable.
    h.advance(4_000);
    assert.equal((await status('first'))?.outcome, 'completed');
    h.advance(2_000);
    await bob.runtime.dispose();
    await runtime.dispose();
    ({ host, runtime } = await h.startHost(5_000));
    assert.equal(await status('first'), null);
    assert.equal((await status('unacknowledged'))?.outcome, 'completed');
    bob = h.startClient('bob', host);
    const loaded = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.equal(loaded.state.drafts[0].target.path, 'file.txt');
    assert.equal(loaded.state.drafts[0].text, 'bob draft');
    assert(loaded.errors.length > 0);
  } finally {
    await h.close();
  }
});

test('createWorktree and initializeRepository replay their first outcome for one request ID', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'main');
    h.git('add', '.');
    h.git('commit', '-qm', 'initial');
    const plain = join(h.base, 'plain');
    mkdirSync(plain);
    const { host } = await h.startHost();
    const main = await openCheckout(host, h.root);
    const request = {
      installationId: 'alice',
      requestId: 'create-1',
      checkout: main,
      base: 'main',
      branch: 'feature/one',
      location: join(h.base, 'feature'),
    };
    const created = await Effect.runPromise(host.createWorktree(request));
    assert.deepEqual(await Effect.runPromise(host.createWorktree(request)), created);
    // A second branch name proves the first request was not run again.
    await assert.rejects(
      Effect.runPromise(host.createWorktree({ ...request, branch: 'feature/two' })),
      (error: unknown) => isError('Conflict')(error),
    );
    assert.equal(
      h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/feature').trim(),
      'feature/one',
    );
    const folder = (await openCheckout(host, plain)) as CheckoutTarget;
    const initialize = {
      installationId: 'alice',
      requestId: 'init-1',
      checkout: folder,
    };
    const initialized = await Effect.runPromise(host.initializeRepository(initialize));
    assert.deepEqual(await Effect.runPromise(host.initializeRepository(initialize)), initialized);
    // A deterministic refusal is replayed even once its cause is gone.
    const refused = {
      ...request,
      requestId: 'refuse-1',
      base: 'later',
      branch: 'feature/three',
      location: join(h.base, 'three'),
    };
    const refusal = (error: unknown) => isError('InvalidInput')(error);
    await assert.rejects(Effect.runPromise(host.createWorktree(refused)), refusal);
    h.git('branch', 'later', 'main');
    await assert.rejects(Effect.runPromise(host.createWorktree(refused)), refusal);
    // A cancellation is transient: the same ID runs again instead of replaying it.
    const retried = {
      ...request,
      requestId: 'retry-1',
      branch: 'feature/four',
      location: join(h.base, 'four'),
    };
    await assert.rejects(
      Effect.runPromise(host.createWorktree(retried), { signal: AbortSignal.abort() }),
    );
    assert.equal((await Effect.runPromise(host.createWorktree(retried))).vcs, 'git');
    // A failure after Git already added the worktree is cleaned up, so the same ID runs again.
    const hook = join(h.root, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const flaky = {
      ...request,
      requestId: 'flaky-1',
      branch: 'feature/five',
      location: join(h.base, 'five'),
    };
    await assert.rejects(Effect.runPromise(host.createWorktree(flaky)), (error: unknown) => {
      assert.ok(isError('Unavailable')(error));
      return true;
    });
    rmSync(hook);
    assert.equal((await Effect.runPromise(host.createWorktree(flaky))).vcs, 'git');
    // A hook that fails and moves the new branch leaves cleanup incomplete: the request ends
    // Uncertain and keeps its reservation, so the same ID is reported interrupted, not run again.
    writeFileSync(
      hook,
      '#!/bin/sh\nexport GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t\n' +
        'git update-ref refs/heads/feature/six "$(git commit-tree -m moved HEAD^{tree})"\nexit 1\n',
      { mode: 0o755 },
    );
    const stuck = {
      ...request,
      requestId: 'stuck-1',
      branch: 'feature/six',
      location: join(h.base, 'six'),
    };
    const uncertain = (error: unknown) => isError('Uncertain')(error);
    await assert.rejects(Effect.runPromise(host.createWorktree(stuck)), uncertain);
    rmSync(hook);
    await assert.rejects(Effect.runPromise(host.createWorktree(stuck)), (error: unknown) => {
      assert.ok(isError('Uncertain')(error));
      assert.match((error as Error).message, /interrupted/);
      return true;
    });
  } finally {
    await h.close();
  }
});

test('a worktree whose reply was lost is asked for again under its first request ID, not made twice', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'main');
    h.git('add', '.');
    h.git('commit', '-qm', 'initial');
    const { host } = await h.startHost();
    const main = await openCheckout(host, h.root);
    const input = {
      checkout: main,
      base: 'main',
      branch: 'feature/one',
      location: join(h.base, 'feature'),
    };
    const uncertain = new ApplicationError({
      code: 'Uncertain',
      message: 'The reply was lost.',
    });
    let alice = h.startClient('alice', host, dropReply('createWorktree', uncertain));
    await assert.rejects(alice.client.command('createWorktree', input), (error: unknown) =>
      isError('Uncertain')(error),
    );
    // The client restarts: the same call is the same request, which replays the worktree.
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    const created = await alice.client.command('createWorktree', input);
    assert.equal(created.root, join(h.base, 'feature'));
    // An answer (here a refusal of the same branch) ends the intent, so a repeat is a new request.
    await assert.rejects(alice.client.command('createWorktree', input), (error: unknown) =>
      isError('Conflict')(error),
    );
    // A repeat that is Uncertain again (the host reports the first request interrupted) ends the
    // ID once reported, so the call after is a new request; concurrent duplicates share one.
    await alice.runtime.dispose();
    const sent: string[] = [];
    let interrupted = true;
    alice = h.startClient('alice', host, (inner) => ({
      ...inner,
      createWorktree: (request) => {
        sent.push(request.requestId);
        return interrupted ? Effect.fail(uncertain) : inner.createWorktree(request);
      },
    }));
    const second = { ...input, branch: 'feature/two', location: join(h.base, 'two') };
    const isUncertain = (error: unknown) => isError('Uncertain')(error);
    await assert.rejects(alice.client.command('createWorktree', second), isUncertain);
    await Promise.all(
      [1, 2].map(() => assert.rejects(alice.client.command('createWorktree', second), isUncertain)),
    );
    interrupted = false;
    assert.equal((await alice.client.command('createWorktree', second)).root, join(h.base, 'two'));
    assert.equal(sent.length, 3);
    assert.equal(sent[1], sent[0]);
    assert.notEqual(sent[2], sent[0]);
  } finally {
    await h.close();
  }
});

test('loading recovery stops waiting on a host that does not answer and still returns the drafts', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'original');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root),
      disk = await Effect.runPromise(host.readFile({ checkout, path: 'file.txt' }));
    const silent = (host: WorkspaceHostServiceShape): WorkspaceHostServiceShape =>
      Object.fromEntries(
        Object.keys(host).map((name) => [name, () => Effect.never]),
      ) as unknown as WorkspaceHostServiceShape;
    const saved = h.startClient('alice', host, dropRequest('saveFile'));
    await saved.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'window',
      expectedRevision: 0,
      state: draft('window', checkout, 'unsaved edit', disk),
    });
    await assert.rejects(
      saved.client.command('saveFile', {
        target: { checkout, path: 'file.txt' },
        clientId: 'window',
        requestId: 'unsettled',
        text: 'unsettled text',
        expectedVersion: disk.version,
      }),
    );
    await saved.runtime.dispose();
    // Another client's unreadable recovery must not hide these drafts either.
    const store = new DatabaseSync(join(h.base, 'alice', 'moonbase-workspace-v1.sqlite'));
    store
      .prepare('INSERT INTO recovery (client, revision, body) VALUES (?, 1, ?)')
      .run('broken', '{');
    store.close();
    const alice = h.startClient('alice', host, silent, 20);
    const load = await alice.client.command('loadRecovery', {
      clientId: 'window',
    });
    // The silent host leaves the local work to do: the unsettled save becomes a draft.
    assert.equal(load.state.drafts[0].text, 'unsettled text');
    assert(load.errors.some((error) => error.includes('broken')));
    assert(load.errors.length > 1);
    // The unreadable row neither stalls a Trash (its feed publication skips it) nor lets a move
    // onto a path that might hold its draft proceed.
    await alice.runtime.dispose();
    const next = h.startClient('alice', host);
    writeFileSync(join(h.root, 'other.txt'), 'other');
    const sources = await next.client.command('inspectEntries', { checkout, paths: ['other.txt'] });
    await assert.rejects(
      next.client.command('mutate', {
        id: 'move',
        clientId: 'window',
        checkout,
        kind: 'move',
        sources,
        destination: 'moved.txt',
      }),
      (error: unknown) => ApplicationError.is(error) && /unreadable/.test(error.message),
    );
    const trashed = await next.client.command('mutate', {
      id: 'trash',
      clientId: 'window',
      checkout,
      kind: 'trash',
      sources,
    });
    assert.equal(trashed.outcome, 'completed');
    // The skipped row may hold a draft at a moved path, so the checkout is marked incomplete.
    const marks = new DatabaseSync(join(h.base, 'alice', 'moonbase-workspace-v1.sqlite'));
    try {
      const gaps = marks.prepare("SELECT body FROM records WHERE bucket='feed-gaps'").all();
      assert(gaps.some((row) => String(row.body).includes(checkout.checkoutId)));
    } finally {
      marks.close();
    }
  } finally {
    await h.close();
  }
});

test('the client store mints its installation ID once and names itself to the host with it', async () => {
  const h = harness();
  try {
    writeFileSync(join(h.root, 'file.txt'), 'original');
    const { host } = await h.startHost();
    const checkout = await openCheckout(host, h.root),
      disk = await Effect.runPromise(host.readFile({ checkout, path: 'file.txt' }));
    const dataDirectory = join(h.base, 'profile');
    const installationId = readInstallationId(dataDirectory);
    assert.equal(readInstallationId(dataDirectory), installationId);
    const runtime = ManagedRuntime.make(WorkspaceRecoveryLive({ dataDirectory }, host));
    try {
      await makeEditorClient(runtime).command('saveFile', {
        target: { checkout, path: 'file.txt' },
        clientId: 'window',
        requestId: 'save',
        text: 'saved',
        expectedVersion: disk.version,
      });
    } finally {
      await runtime.dispose();
    }
    const status = host.saveStatus({ installationId, clientId: 'window', requestId: 'save' });
    assert.equal((await Effect.runPromise(status)).kind, 'saved');
  } finally {
    await h.close();
  }
});
