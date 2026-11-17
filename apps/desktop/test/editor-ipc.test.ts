import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApplicationError,
  type CheckoutTarget,
  type WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import {
  emptyBufferView,
  emptyRecoveryState,
  type RecoveryLayout,
  type RecoveryOutline,
} from '@moonbase/contracts/recovery';
import { Effect } from 'effect';
import type { NativeActions } from '../src/main/native-actions.ts';
import {
  makeIpcFixture,
  unusedNative,
  waitFor,
  type FakeWorkspaceClient,
} from './fixtures/ipc-fixture.ts';

const target: CheckoutTarget = {
  hostId: 'local-host',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/approved',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};
const worktree = (root: string) => ({
  root,
  branch: 'topic',
  main: false,
  locked: false,
  prunable: false,
});
/** A workspace that answers what these tests ask and counts what reached it. */
function fakeWorkspace(overrides: Partial<Record<string, (input: never) => unknown>> = {}) {
  const dispatched: string[] = [];
  const client: FakeWorkspaceClient = {
    command: async (operation, input) => {
      dispatched.push(operation);
      const override = overrides[operation];
      if (override) return (await override(input as never)) as never;
      if (operation === 'openCheckout') return target as never;
      if (operation === 'listWorktrees')
        return { worktrees: [worktree('/approved-topic')] } as never;
      if (operation === 'loadRecovery')
        return {
          state: { ...emptyRecoveryState('desktop-primary'), checkouts: [target] },
          operations: [
            {
              id: 'earlier-operation',
              clientId: 'earlier-client',
              checkout: target,
              kind: 'trash',
              recoveryChanges: [],
              outcome: 'completed',
              items: [],
            },
          ],
          errors: [],
        } as never;
      if (operation === 'operationStatus') return null as never;
      return { paths: [] } as never;
    },
    watch: () => async () => {},
    watchRecovery: (input, receive) => {
      dispatched.push('watchRecovery');
      receive({ ...emptyRecoveryState(input.clientId), buffers: [] });
      return async () => {};
    },
  };
  return { client, dispatched };
}
/** A layout with `checkouts` open and nothing else. */
const layout = (checkouts: CheckoutTarget[]): RecoveryLayout => {
  const {
    version: _version,
    clientId: _clientId,
    buffers: _buffers,
    ...rest
  } = emptyRecoveryState('desktop-primary');
  return {
    ...rest,
    checkouts,
    views: Object.fromEntries(checkouts.map((c) => [c.checkoutId, emptyBufferView()])),
  };
};
const native = (overrides: Partial<NativeActions> = {}): NativeActions => ({
  ...unusedNative,
  chooseCheckout: Effect.succeed('/approved'),
  ...overrides,
});

test('a command reaches the workspace only for what main approved for this window', async () => {
  const workspace = fakeWorkspace();
  const f = await makeIpcFixture({ editor: { client: workspace.client, native: native() } });
  try {
    const refused = async (operation: string, input: unknown, refusal: string) =>
      assert.deepEqual(
        await f.call(operation, input),
        { ok: false, error: { _tag: 'IpcAuthorityError', refusal } },
        operation,
      );
    // A renderer path or checkout grants nothing.
    await refused('openCheckout', { root: '/approved' }, 'root');
    await refused('readFile', { checkout: target, path: 'a.ts' }, 'checkout');
    await refused('loadRecovery', { clientId: 'foreign' }, 'foreign-client');
    assert.deepEqual(workspace.dispatched, []);
    // The picker's root opens once.
    assert.equal(await f.shell.chooseCheckout(), '/approved');
    await f.editor.command('openCheckout', { root: '/approved' });
    await refused('openCheckout', { root: '/elsewhere' }, 'root');
    // A known checkout's root opens again once its picker grant is spent.
    await f.editor.command('openCheckout', { root: '/approved' });
    // An exact approved checkout only: another host's copy of it is refused.
    await refused(
      'readFile',
      { checkout: { ...target, hostId: 'other' }, path: 'a.ts' },
      'checkout',
    );
    // Recovery edits: only this window's client, and only approved checkouts.
    const other = { ...target, checkoutId: 'other' };
    await refused(
      'updateLayout',
      { clientId: 'desktop-primary', layout: layout([other]) },
      'checkout',
    );
    await refused(
      'openTab',
      { clientId: 'desktop-primary', bufferId: 'b1', target: { checkout: other, path: 'a.ts' } },
      'checkout',
    );
    await refused(
      'updateDraft',
      {
        clientId: 'foreign',
        bufferId: 'b1',
        text: 'x',
        disk: { text: '', version: 'v' },
      },
      'foreign-client',
    );
    await refused('watchRecovery', { clientId: 'foreign' }, 'foreign-client');
    await f.editor.command('openTab', {
      clientId: 'desktop-primary',
      bufferId: 'b1',
      target: { checkout: target, path: 'a.ts' },
    });
    await f.editor.command('updateDraft', {
      clientId: 'desktop-primary',
      bufferId: 'b1',
      text: 'draft',
      disk: { text: 'A', version: 'v' },
    });
    await f.editor.command('updateLayout', {
      clientId: 'desktop-primary',
      layout: layout([target]),
    });
    await f.editor.command('closeTab', { clientId: 'desktop-primary', bufferId: 'b1' });
    const outlines: RecoveryOutline[] = [];
    const close = f.editor.watchRecovery(
      { clientId: 'desktop-primary' },
      (outline) => outlines.push(outline),
      () => {},
    );
    await waitFor(() => outlines.length === 1);
    await close();
    // Git's listed worktrees of an approved checkout may open; a renderer location never makes one.
    await refused('openCheckout', { root: '/approved-topic' }, 'root');
    await f.editor.command('listWorktrees', { checkout: target });
    await f.editor.command('openCheckout', { root: '/approved-topic' });
    await refused(
      'createWorktree',
      { checkout: target, base: 'main', branch: 'feature', location: '/anywhere/feature' },
      'worktree-location',
    );
    // Recovery's operations of an earlier client may be asked after; others may not.
    await f.editor.command('loadRecovery', { clientId: 'desktop-primary' });
    await f.editor.command('operationStatus', {
      clientId: 'earlier-client',
      id: 'earlier-operation',
    });
    await refused('operationStatus', { clientId: 'earlier-client', id: 'other' }, 'foreign-client');
    await refused(
      'acknowledgeOperation',
      { clientId: 'desktop-primary', operationClientId: 'earlier-client', id: 'other' },
      'foreign-client',
    );
    assert.deepEqual(await f.call('operationStatus', { clientId: 'earlier.client', id: 'x' }), {
      ok: false,
      error: { _tag: 'IpcInputError', problem: 'request-id' },
    });
    assert.deepEqual(workspace.dispatched, [
      'openCheckout',
      'openCheckout',
      'openTab',
      'updateDraft',
      'updateLayout',
      'closeTab',
      'watchRecovery',
      'listWorktrees',
      'openCheckout',
      'loadRecovery',
      'operationStatus',
    ]);
  } finally {
    await f.dispose();
  }
});

test('approvals outlive a document, but its picker grants do not', async () => {
  const workspace = fakeWorkspace();
  const f = await makeIpcFixture({ editor: { client: workspace.client, native: native() } });
  try {
    await f.shell.chooseCheckout();
    await f.releaseDocument();
    // The replaced document's pick grants the new one nothing.
    assert.deepEqual(await f.call('openCheckout', { root: '/approved' }), {
      ok: false,
      error: { _tag: 'IpcAuthorityError', refusal: 'root' },
    });
    await f.shell.chooseCheckout();
    await f.editor.command('openCheckout', { root: '/approved' });
    await f.releaseDocument();
    // An opened checkout stays approved, and its root opens again.
    await f.editor.command('listWorktrees', { checkout: target });
    await f.editor.command('openCheckout', { root: '/approved' });
  } finally {
    await f.dispose();
  }
});

test('a plain folder main adopts opens for the renderer, and Initialize Git replaces its approval', async () => {
  const folder: CheckoutTarget = {
    hostId: 'local-host',
    checkoutId: 'notes',
    projectId: 'notes',
    root: '/notes',
    vcs: 'none',
  };
  const initialized: CheckoutTarget = {
    ...folder,
    projectId: 'repository',
    vcs: 'git',
    branch: 'main',
    worktree: 'main',
  };
  const workspace = fakeWorkspace({
    openCheckout: () => folder,
    initializeRepository: () => initialized,
  });
  const f = await makeIpcFixture({ editor: { client: workspace.client } });
  try {
    const ignored = (checkout: unknown) =>
      f.call('getIgnoredPaths', { checkout, path: '', paths: ['a.txt'] });
    assert.equal((await f.call('openCheckout', { root: folder.root })).ok, false);
    f.approvals.adoptCheckout(folder);
    await f.editor.command('openCheckout', { root: folder.root });
    assert((await ignored(folder)).ok);
    // A Git-shaped copy of the folder's target is not its approval.
    assert.equal(
      (await ignored({ ...folder, vcs: 'git', branch: 'main', worktree: 'main' })).ok,
      false,
    );
    assert.deepEqual(
      await f.editor.command('initializeRepository', { checkout: folder }),
      initialized,
    );
    assert.equal((await ignored(folder)).ok, false);
    assert((await ignored(initialized)).ok);
  } finally {
    await f.dispose();
  }
});

test('an editor command is held to its input bounds before it reaches the workspace', async () => {
  const workspace = fakeWorkspace();
  const f = await makeIpcFixture({ editor: { client: workspace.client } });
  try {
    f.approvals.adoptCheckout(target);
    const ignored = (paths: string[]) =>
      f.call('getIgnoredPaths', { checkout: target, path: '', paths });
    // A whole folder listing may be classified, and no more.
    assert((await ignored(Array(20000).fill('a.ts'))).ok);
    assert.equal((await ignored(Array(20001).fill('a.ts'))).ok, false);
    // What a command's schema leaves open is bounded too: a Trash's replacements, say.
    const entry = (identity: string) => ({
      target: { checkout: target, path: 'a.ts' },
      identity,
      directory: false,
    });
    const trash = (replacements: unknown[]) =>
      f.call('mutate', {
        id: 'operation',
        clientId: 'desktop-primary',
        checkout: target,
        kind: 'trash',
        sources: [],
        replacements,
      });
    for (const [replacements, problem] of [
      [Array(8193).fill(entry('a')), 'array-too-long'],
      [[entry('a'.repeat(2 ** 24 + 1))], 'string-too-long'],
      [[entry('a'.repeat(2 ** 25))], 'too-large'],
    ] as const)
      assert.deepEqual(await trash([...replacements]), {
        ok: false,
        error: { _tag: 'IpcInputError', problem },
      });
    assert.deepEqual(workspace.dispatched, ['getIgnoredPaths']);
  } finally {
    await f.dispose();
  }
});

test('copyPaths and revealPath reach native actions only for approved checkouts and paths inside them', async () => {
  // A real folder, so reveal can follow links: `out` points outside the checkout.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-reveal-')));
  const root = join(base, 'checkout');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'A');
  await writeFile(join(base, 'secret'), 'S');
  await symlink(base, join(root, 'out'));
  const checkout = { ...target, root };
  const copied: string[] = [],
    revealed: string[] = [];
  let localHost: string | undefined = 'local-host';
  const f = await makeIpcFixture({
    editor: {
      native: native({
        copyText: (text) => Effect.sync(() => void copied.push(text)),
        reveal: (path) => Effect.sync(() => void revealed.push(path)),
      }),
      localHostId: Effect.sync(() => localHost),
    },
  });
  const copy = (paths: unknown, relative: unknown = false) =>
    f.call('copyPaths', { checkout, paths, relative });
  const reveal = (path: unknown, at = checkout) => f.call('revealPath', { checkout: at, path });
  try {
    // Not yet approved: the renderer naming a checkout grants nothing.
    assert.equal((await copy(['src/a.ts'])).ok, false);
    assert.equal((await reveal('src/a.ts')).ok, false);
    f.approvals.adoptCheckout(checkout);
    await f.shell.copyPaths(checkout, ['src/a.ts', ''], false);
    await f.shell.copyPaths(checkout, ['src/a.ts', 'src'], true);
    assert.deepEqual(copied, [`${join(root, 'src/a.ts')}\n${root}`, 'src/a.ts\nsrc']);
    for (const paths of [[], 'src/a.ts', [7], Array.from({ length: 20001 }, () => 'a')])
      assert.equal((await copy(paths)).ok, false, JSON.stringify(paths).slice(0, 40));
    assert.equal((await copy(['src/a.ts'], 'yes')).ok, false);
    await f.shell.revealPath(checkout, 'src/a.ts');
    await f.shell.revealPath(checkout, '');
    for (const path of [
      '../outside',
      'src/../../outside',
      '/etc/hosts',
      './src',
      'src//a.ts',
      'src\\a.ts',
      'src/\0',
      'a'.repeat(4097),
      // Inside by name, outside once the link is followed.
      'out/secret',
      // Gone since the menu opened.
      'src/missing.ts',
    ]) {
      assert.equal((await reveal(path)).ok, false, path.slice(0, 40));
      assert.equal((await copy([path])).ok, path === 'out/secret' || path === 'src/missing.ts');
    }
    assert.deepEqual(await reveal('src/missing.ts'), {
      ok: false,
      error: { _tag: 'NativeActionError', failure: 'reveal-missing' },
    });
    assert.equal((await reveal('secret', { ...checkout, root: base })).ok, false);
    assert.deepEqual(revealed, [join(root, 'src/a.ts'), root]);
    // Files of a host that is not this Mac's daemon can be copied by path but not shown in Finder.
    localHost = 'another-host';
    assert.deepEqual(await reveal('src/a.ts'), {
      ok: false,
      error: { _tag: 'NativeActionError', failure: 'reveal-other-host' },
    });
    assert((await copy(['src/a.ts'])).ok);
    localHost = undefined;
    assert.equal((await reveal('src/a.ts')).ok, false);
    assert.equal(revealed.length, 2);
  } finally {
    await f.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('captured imports belong to the document: released with it, or at once when their request is cancelled', async () => {
  const released: string[][] = [];
  let capture = Promise.withResolvers<string[]>();
  const choose = Promise.withResolvers<string[]>();
  let captures = 0;
  let release: () => Promise<void> = async () => {};
  const f = await makeIpcFixture({
    editor: {
      native: native({
        choosePaths: () => Effect.promise(() => choose.promise),
        capture: () =>
          Effect.promise(() => {
            captures++;
            return capture.promise;
          }),
        release: ({ references }) =>
          Effect.promise(async () => {
            released.push(references);
            await release();
          }),
      }),
    },
  });
  try {
    f.approvals.adoptCheckout(target);
    capture.resolve(['kept']);
    assert.deepEqual(await f.shell.dropImports(target, [new File([''], '/dropped.txt')]), ['kept']);
    assert.deepEqual(released, []);
    // A request whose document goes while the user chooses captures nothing.
    const choosing = f.shell.pasteImports(target);
    void choosing.catch(() => {});
    await f.releaseDocument();
    choose.resolve(['/pasted']);
    await assert.rejects(choosing);
    assert.equal(captures, 1);
    // A capture still under way when its document goes finishes, and is released, not offered.
    capture = Promise.withResolvers();
    const late = f.shell.pasteImports(target);
    void late.catch(() => {});
    await waitFor(() => captures === 2);
    const releasing = f.releaseDocument();
    capture.resolve(['late']);
    await releasing;
    await assert.rejects(late);
    assert.deepEqual(released, [['kept'], ['late']]);
    // A failed release has no request to answer with, so it is reported.
    release = async () => {
      throw new ApplicationError({ code: 'Persistence', message: 'Release failed' });
    };
    capture = Promise.withResolvers();
    capture.resolve(['failing']);
    await f.shell.pasteImports(target);
    await f.releaseDocument();
    assert.deepEqual(
      f.cleanupFailures.map((error) => (error as ApplicationError).code),
      ['Persistence'],
    );
  } finally {
    await f.dispose();
  }
});

test('a workspace watch delivers its events until closed, and closing it closes main’s watch', async () => {
  let receive: ((event: WorkspaceEvent) => void) | undefined;
  let closes = 0;
  const f = await makeIpcFixture({
    editor: {
      client: {
        ...fakeWorkspace().client,
        watch: (_input, deliver) => {
          receive = deliver;
          return async () => {
            closes++;
          };
        },
      },
    },
  });
  try {
    f.approvals.adoptCheckout(target);
    const events: WorkspaceEvent[] = [];
    const close = f.editor.watch(
      { checkout: target, paths: [] },
      (event) => events.push(event),
      () => {},
    );
    await waitFor(() => receive);
    receive!({ checkout: target, paths: ['a.ts'] });
    await waitFor(() => events.length === 1);
    await close();
    await waitFor(() => closes === 1);
    // Delivery stops at close.
    receive!({ checkout: target, paths: ['b.ts'] });
    assert.equal(events.length, 1);
  } finally {
    await f.dispose();
  }
});
