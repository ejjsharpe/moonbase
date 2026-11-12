import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceHostLive, WorkspaceRecoveryLive } from '../src/index.ts';
import { draft } from './workspace-fixture.ts';

/** One file host and any number of client stores over it, as a daemon and its clients are. */
function harness() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-split-'))),
    root = join(base, 'repo');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ]).toString();
  const runtimes: { dispose(): Promise<void> }[] = [];
  let clock = 1_000;
  const startHost = async (retention = 60_000) => {
    const runtime = ManagedRuntime.make(
      WorkspaceHostLive(
        { dataDirectory: join(base, 'host'), hostId: 'split-host', journalRetentionMs: retention },
        () => clock,
      ),
    );
    runtimes.push(runtime);
    return { runtime, host: await runtime.runPromise(WorkspaceHostService) };
  };
  /** A client store whose host calls may be wrapped to lose a request or its reply. */
  const startClient = (
    name: string,
    host: WorkspaceHostServiceShape,
    lose?: (host: WorkspaceHostServiceShape) => WorkspaceHostServiceShape,
  ) => {
    const runtime = ManagedRuntime.make(
      WorkspaceRecoveryLive(
        { dataDirectory: join(base, name), installationId: name },
        lose ? lose(host) : host,
      ),
    );
    runtimes.push(runtime);
    return { runtime, client: makeEditorClient(runtime) };
  };
  return {
    base,
    root,
    git,
    startHost,
    startClient,
    advance: (ms: number) => (clock += ms),
    async close() {
      for (const runtime of runtimes.reverse()) await runtime.dispose().catch(() => {});
      rmSync(base, { recursive: true, force: true });
    },
  };
}
const lost = new ApplicationError({ code: 'Unavailable', message: 'The host did not answer.' });
const dropRequest =
  <K extends 'saveFile' | 'mutate'>(operation: K) =>
  (host: WorkspaceHostServiceShape): WorkspaceHostServiceShape => ({
    ...host,
    [operation]: () => Effect.fail(lost),
  });
/** The host commits, then the link goes down: the reply and every status query are lost. */
const dropReply =
  <K extends 'saveFile' | 'mutate'>(operation: K, failure: ApplicationError = lost) =>
  (host: WorkspaceHostServiceShape): WorkspaceHostServiceShape => ({
    ...host,
    [operation]: (input: never) =>
      Effect.flatMap(
        (host[operation] as (input: never) => Effect.Effect<unknown, ApplicationError>)(input),
        () => Effect.fail(failure),
      ),
    saveStatus: () => Effect.fail(lost),
    operationStatus: () => Effect.fail(lost),
  });
const openCheckout = (host: WorkspaceHostServiceShape, root: string) =>
  Effect.runPromise(host.openCheckout({ root }));

test('a save whose reply is lost resolves through saveStatus, and one that never arrived returns as a draft', async () => {
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
    const malformed = new ApplicationError({ code: 'Incompatible', message: 'Malformed.' });
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
    const resolved = await alice.client.command('loadRecovery', { clientId: 'window' });
    assert.equal(resolved.state.drafts[0].disk.text, 'committed text');
    assert.deepEqual(resolved.errors, []);
    assert.equal(
      (
        await Effect.runPromise(
          host.saveStatus({ installationId: 'alice', clientId: 'window', requestId: 'lost-reply' }),
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
    alice = h.startClient('alice', host);
    const restored = await alice.client.command('loadRecovery', { clientId: 'window' });
    assert.equal(restored.state.drafts[0].text, 'unsent text');
    assert.equal(restored.state.drafts[0].disk.text, 'committed text');
    assert.equal(readFileSync(join(h.root, 'file.txt'), 'utf8'), 'committed text');
    // The host told the client `not-started`, so a delayed copy of that request never runs.
    const late = await Effect.runPromise(
      Effect.flip(
        host.saveFile({
          installationId: 'alice',
          ...save('never-arrived', 'unsent text', resolved.state.drafts[0].disk.version),
        }),
      ),
    );
    assert.equal(late.code, 'Conflict');
    assert.equal(readFileSync(join(h.root, 'file.txt'), 'utf8'), 'committed text');
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
    const sources = await alice.client.command('inspectEntries', { checkout, paths: ['file.txt'] });
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
    const loaded = await alice.client.command('loadRecovery', { clientId: 'window' });
    assert.equal(loaded.state.drafts[0].target.path, 'moved.txt');
    assert.equal(loaded.state.drafts[0].text, 'dirty');
  } finally {
    await h.close();
  }
});

test("one client's move re-paths another client's draft on its next load, and its Trash leaves the draft", async () => {
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
    assert.equal(
      (await bob.client.command('loadRecovery', { clientId: 'b' })).state.drafts.length,
      2,
    );
    const run = async (id: string, kind: 'move' | 'trash', path: string, destination?: string) =>
      alice.client.command('mutate', {
        id,
        clientId: 'a',
        checkout,
        kind,
        sources: await alice.client.command('inspectEntries', { checkout, paths: [path] }),
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
            ? Effect.fail(new ApplicationError({ code: 'Unauthorized', message: 'Replaced.' }))
            : inner.listOperations(input),
      }));
    await bob.client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'b',
      expectedRevision: 0,
      state: { ...draft('b', checkout, 'bob', disk), checkouts: [checkout, stale] },
    });
    await bob.client.command('loadRecovery', { clientId: 'b' });
    await alice.client.command('mutate', {
      id: 'move',
      clientId: 'a',
      checkout,
      kind: 'move',
      sources: await alice.client.command('inspectEntries', { checkout, paths: ['file.txt'] }),
      destination: 'renamed.txt',
    });
    const loaded = await bob.client.command('loadRecovery', { clientId: 'b' });
    assert.equal(loaded.state.drafts[0].target.path, 'renamed.txt');
    assert(loaded.errors.length > 0);
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
      Effect.runPromise(host.acknowledgeOperation({ installationId: 'alice', clientId: 'a', id }));
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
      (error: unknown) => ApplicationError.is(error) && error.code === 'Conflict',
    );
    assert.equal(
      h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/feature').trim(),
      'feature/one',
    );
    const folder = (await openCheckout(host, plain)) as CheckoutTarget;
    const initialize = { installationId: 'alice', requestId: 'init-1', checkout: folder };
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
    const refusal = (error: unknown) => ApplicationError.is(error) && error.code === 'InvalidInput';
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
    // A failure after Git already added the worktree is cleaned up and equally retryable.
    const hook = join(h.root, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const flaky = {
      ...request,
      requestId: 'flaky-1',
      branch: 'feature/five',
      location: join(h.base, 'five'),
    };
    await assert.rejects(Effect.runPromise(host.createWorktree(flaky)), (error: unknown) => {
      assert.ok(ApplicationError.is(error));
      assert.equal(error.code, 'Unavailable');
      return true;
    });
    rmSync(hook);
    assert.equal((await Effect.runPromise(host.createWorktree(flaky))).vcs, 'git');
  } finally {
    await h.close();
  }
});
