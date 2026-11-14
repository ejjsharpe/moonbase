import { acquireEditor } from './editor-model-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type EditorClient,
} from '@moonbase/contracts/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { checkoutKey } from '@moonbase/application/editor';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

const folder: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'notes',
  projectId: 'notes-folder',
  root: '/memory/notes',
  vcs: 'none',
};
const repository: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'repo',
  projectId: 'repo',
  root: '/memory/repo',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

/** Holds `initializeRepository` after `git init` ran until `release`, as a slow Git does. */
function hold() {
  let started!: () => void, release!: () => void;
  return {
    started: new Promise<void>((resolve) => (started = resolve)),
    release: new Promise<void>((resolve) => (release = resolve)),
    start: () => started(),
    finish: () => release(),
  };
}

async function fixture(
  options: {
    initialization?: ReturnType<typeof hold>;
    failGitWatch?: boolean;
    /** `git init` runs, but its reply is lost. */
    loseInitReply?: boolean;
  } = {},
) {
  const memory = fauxWorkspace([
    { checkout: folder, files: { 'a.ts': 'a', 'b.ts': 'b' } },
    { checkout: repository, files: { 'r.ts': 'r' }, head: { 'r.ts': 'r' } },
  ]);
  const runtime = ManagedRuntime.make(memory.layer);
  const inner = makeEditorClient(runtime);
  const commands: string[] = [];
  let initialized = false,
    failGitWatch = options.failGitWatch ?? false;
  const client: EditorClient = {
    command: async (operation, input, options_) => {
      commands.push(operation);
      // After `git init` the workspace no longer approves the folder target, so it refuses a
      // publication that names it, as the native workspace does.
      if (
        operation === 'persistRecovery' &&
        initialized &&
        (input as CommandInput<'persistRecovery'>).state.checkouts.some(
          (checkout) => checkoutKey(checkout) === checkoutKey(folder),
        )
      )
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'Exact checkout identity is not approved.',
        });
      const output = await inner.command(operation, input, options_);
      if (operation === 'initializeRepository') {
        initialized = true;
        options.initialization?.start();
        await options.initialization?.release;
        if (options.loseInitReply)
          throw new ApplicationError({ code: 'Unavailable', message: 'The reply was lost.' });
      }
      return output;
    },
    watch: (input, ...rest) => {
      if (failGitWatch && input.checkout.vcs === 'git' && input.checkout.root === folder.root) {
        failGitWatch = false;
        throw new ApplicationError({ code: 'Unavailable', message: 'Watch could not start.' });
      }
      return inner.watch(input, ...rest);
    },
  };
  const editor = await acquireEditor(runtime, { client, clientId: 'folders' });
  await editor.load();
  return {
    editor,
    memory,
    commands,
    inner,
    runtime,
    async dispose() {
      await editor.dispose();
      await runtime.dispose();
    },
  };
}
const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(condition());
};
/** Opens the folder with `a.ts` showing, and starts initializing it under `initialization`. */
async function startInitializing(
  f: Awaited<ReturnType<typeof fixture>>,
  initialization: ReturnType<typeof hold>,
) {
  await f.editor.openCheckout(folder.root);
  await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
  const initializing = f.editor.initializeRepository(folder);
  await initialization.started;
  assert.equal(f.editor.getSnapshot().initializing, folder.checkoutId);
  return { initializing, commands: f.commands.length };
}

test('a plain-folder checkout opens and refreshes with an empty Git status', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.editor.openCheckout(folder.root), folder);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    await f.editor.refresh(folder);
    // The workspace answers a plain folder's Git status with no changes.
    assert.deepEqual(f.editor.getSnapshot().git[checkoutKey(folder)]?.changes, []);
    assert.deepEqual((await f.editor.listWorktrees(folder)).worktrees, []);
    await f.editor.openCheckout(repository.root);
    await assert.rejects(
      f.editor.initializeRepository(repository),
      (error: unknown) => ApplicationError.is(error) && error.code === 'InvalidInput',
    );
  } finally {
    await f.dispose();
  }
});

test('initializeRepository keeps the folder’s tabs and drafts on the Git checkout it becomes', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'b.ts' }, { intent: 'keep' });
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'unsaved');
    await f.editor.openCheckout(repository.root);
    await f.editor.selectCheckout(folder);

    const initialized = await f.editor.initializeRepository(folder);
    assert.equal(initialized.vcs, 'git');
    assert.equal(initialized.checkoutId, folder.checkoutId);
    const { recovery, buffers, git } = f.editor.getSnapshot();
    assert.deepEqual(recovery.checkouts, [initialized, repository]);
    assert.deepEqual(recovery.openCheckoutIds, [folder.checkoutId, repository.checkoutId]);
    assert.equal(recovery.selectedCheckoutId, initialized.checkoutId);
    assert.deepEqual(recovery.views[initialized.checkoutId].openFiles, ['b.ts', 'a.ts']);
    assert.equal(recovery.views[initialized.checkoutId].active, 'a.ts');
    assert(buffers.every((buffer) => buffer.target.checkout.vcs === 'git'));
    assert.equal(f.editor.buffer({ checkout: initialized, path: 'a.ts' })?.text, 'unsaved');
    assert.equal(f.editor.buffer({ checkout: folder, path: 'a.ts' }), undefined);
    // Git status is read for the new checkout: nothing is committed yet.
    assert.deepEqual(git[checkoutKey(initialized)]?.changes.map((change) => change.path).sort(), [
      'a.ts',
      'b.ts',
    ]);
    // The draft was published with the Git target, and saves to it.
    const saved = await f.inner.command('loadRecovery', { clientId: 'folders' });
    assert.deepEqual(
      saved.state.drafts.map((draft) => [draft.target.checkout, draft.target.path, draft.text]),
      [[initialized, 'a.ts', 'unsaved']],
    );
    assert.equal(await f.editor.save({ checkout: initialized, path: 'a.ts' }), true);
    assert.equal(
      (await f.inner.command('readFile', { checkout: initialized, path: 'a.ts' })).text,
      'unsaved',
    );
    await assert.rejects(f.editor.initializeRepository(folder), ApplicationError.is);
  } finally {
    await f.dispose();
  }
});

test('a failed initializeRepository leaves the plain folder open and observed', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.memory.failNext('initializeRepository', 'Git could not start.');
    await assert.rejects(f.editor.initializeRepository(folder), /Git could not start/);
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [folder]);
    // Its watch is back: a change on disk reaches the editor.
    const revision = f.editor.getSnapshot().discoveryRevision;
    f.memory.externalWrite({ checkout: folder, path: 'a.ts' }, 'changed outside');
    const deadline = Date.now() + 2000;
    while (f.editor.getSnapshot().discoveryRevision === revision && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(f.editor.getSnapshot().discoveryRevision > revision);
  } finally {
    await f.dispose();
  }
});

test('a lost initializeRepository reply after git init still moves the folder to its repository', async () => {
  const f = await fixture({ loseInitReply: true });
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'draft');
    const initialized = await f.editor.initializeRepository(folder);
    assert.equal(initialized.vcs, 'git');
    assert.equal(initialized.checkoutId, folder.checkoutId);
    const state = f.editor.getSnapshot();
    assert.deepEqual(state.recovery.checkouts, [initialized]);
    assert.deepEqual(state.errors, []);
    assert.equal(state.buffers.find((buffer) => buffer.target.path === 'a.ts')?.text, 'draft');
  } finally {
    await f.dispose();
  }
});

test('opening a file during initializeRepository waits, then opens it in the repository', async () => {
  const initialization = hold();
  const f = await fixture({ initialization });
  try {
    const { initializing } = await startInitializing(f, initialization);
    let opened: boolean | undefined;
    const opening = f.editor
      .open({ checkout: folder, path: 'b.ts' }, { intent: 'keep' })
      .then((value) => (opened = value));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened, undefined);
    initialization.finish();
    const initialized = await initializing;
    await opening;
    assert.equal(opened, true);
    const state = f.editor.getSnapshot();
    assert.deepEqual(state.errors, []);
    assert(state.recovery.views[initialized.checkoutId]!.openFiles.includes('b.ts'));
  } finally {
    await f.dispose();
  }
});

test('reopening a closed folder that became a repository rebinds it instead of refusing', async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(folder.root);
    assert.equal(await f.editor.closeCheckout(folder), true);
    const initialized = await f.inner.command('initializeRepository', { checkout: folder });
    assert.deepEqual(await f.editor.openCheckout(folder.root), initialized);
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [initialized]);
  } finally {
    await f.dispose();
  }
});

test('a save or file operation during initializeRepository is refused, and the rebind completes', async () => {
  const initialization = hold();
  const f = await fixture({ initialization });
  try {
    const { initializing, commands } = await startInitializing(f, initialization);
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'saved later');
    assert.equal(await f.editor.save({ checkout: folder, path: 'a.ts' }), false);
    assert.match(f.editor.getSnapshot().errors.at(-1)!, /Git is initializing/);
    await assert.rejects(
      f.editor.mutate({
        checkout: folder,
        kind: 'create-file',
        sources: [],
        destination: 'c.ts',
        text: 'c',
      }),
      /Git is initializing/,
    );
    assert.deepEqual(f.editor.getSnapshot().operations, []);
    assert(!f.commands.slice(commands).some((name) => name === 'saveFile' || name === 'mutate'));

    initialization.finish();
    const initialized = await initializing;
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [initialized]);
    assert.equal(f.editor.getSnapshot().initializing, null);
    // Saving works again, on the Git checkout.
    assert.equal(await f.editor.save({ checkout: initialized, path: 'a.ts' }), true);
    assert.equal(
      (await f.inner.command('readFile', { checkout: initialized, path: 'a.ts' })).text,
      'saved later',
    );
  } finally {
    await f.dispose();
  }
});

test('an edit during initializeRepository is kept and published under the Git target', async () => {
  const initialization = hold();
  const f = await fixture({ initialization });
  try {
    const { initializing, commands } = await startInitializing(f, initialization);
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'typed while Git initializes');
    // Past the publication debounce, nothing has published the retired folder target.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(!f.commands.slice(commands).includes('persistRecovery'));
    assert.equal(f.editor.getSnapshot().recoveryReady, false);

    initialization.finish();
    const initialized = await initializing;
    const snapshot = f.editor.getSnapshot();
    assert.equal(snapshot.publication, undefined);
    assert.deepEqual(snapshot.errors, []);
    assert.equal(
      f.editor.buffer({ checkout: initialized, path: 'a.ts' })?.text,
      'typed while Git initializes',
    );
    const saved = await f.inner.command('loadRecovery', { clientId: 'folders' });
    assert.deepEqual(saved.state.checkouts, [initialized]);
    assert.deepEqual(
      saved.state.drafts.map((draft) => [draft.target.checkout, draft.target.path, draft.text]),
      [[initialized, 'a.ts', 'typed while Git initializes']],
    );
    // Later edits keep publishing.
    f.editor.edit({ checkout: initialized, path: 'a.ts' }, 'and after');
    await f.editor.flush();
    assert.equal(
      (await f.inner.command('loadRecovery', { clientId: 'folders' })).state.drafts[0]?.text,
      'and after',
    );
  } finally {
    await f.dispose();
  }
});

test('a second initializeRepository during the first is refused and leaves it to finish', async () => {
  const initialization = hold();
  const f = await fixture({ initialization });
  try {
    const { initializing, commands } = await startInitializing(f, initialization);
    await assert.rejects(
      f.editor.initializeRepository(folder),
      (error: unknown) =>
        ApplicationError.is(error) &&
        error.code === 'Conflict' &&
        /already being initialized/.test(error.message),
    );
    assert.equal(
      f.commands.slice(commands).filter((name) => name === 'initializeRepository').length,
      0,
    );
    initialization.finish();
    const initialized = await initializing;
    assert.deepEqual(f.editor.getSnapshot().recovery.checkouts, [initialized]);
    assert.deepEqual(f.editor.getSnapshot().errors, []);
  } finally {
    await f.dispose();
  }
});

test('if the rebind fails after git init, the folder’s work still moves to the repository and is watched', async () => {
  const f = await fixture({ failGitWatch: true });
  try {
    await f.editor.openCheckout(folder.root);
    await f.editor.open({ checkout: folder, path: 'a.ts' }, { intent: 'keep' });
    f.editor.edit({ checkout: folder, path: 'a.ts' }, 'unsaved');
    await assert.rejects(
      f.editor.initializeRepository(folder),
      /Git was initialized, but the project did not finish moving to it: Watch could not start\./,
    );
    const { recovery, initializing, publication } = f.editor.getSnapshot();
    const initialized = recovery.checkouts[0];
    assert.equal(initialized.vcs, 'git');
    assert.deepEqual(recovery.checkouts, [initialized]);
    assert.equal(initializing, null);
    assert.equal(publication, undefined);
    assert.equal(f.editor.buffer({ checkout: initialized, path: 'a.ts' })?.text, 'unsaved');
    assert.deepEqual(
      (await f.inner.command('loadRecovery', { clientId: 'folders' })).state.drafts.map((draft) => [
        draft.target.checkout,
        draft.text,
      ]),
      [[initialized, 'unsaved']],
    );
    // Its watch is up on the repository: a change on disk reaches the editor.
    const revision = f.editor.getSnapshot().discoveryRevision;
    f.memory.externalWrite({ checkout: initialized, path: 'b.ts' }, 'changed outside');
    await waitUntil(() => f.editor.getSnapshot().discoveryRevision > revision);
  } finally {
    // Disposal reports the watch that failed to start, as it does for any such watch.
    await assert.rejects(f.editor.dispose(), /Watch could not start/);
    await f.runtime.dispose();
  }
});
