import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireEditor } from './editor-model-fixture.ts';
import { checkout, second, fixture, held, target } from './editor-fixture.ts';
import { fileKey, type EditorSnapshot } from '@moonbase/application/editor';
import { Effect } from 'effect';
import { ApplicationError, type WorkspaceEvent } from '@moonbase/contracts/workspace';

async function until(check: () => unknown) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(check());
}

test('overlapping folder reads share one request and later navigation reads fresh entries', async () => {
  const f = await fixture('listing-source', false);
  const entered = held(),
    release = held();
  let calls = 0;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-navigation',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'listDirectory' && (input as { path: string }).path === 'folder') {
          calls++;
          entered.release();
          await release.promise;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  const reads: Promise<unknown>[] = [];
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    const first = editor.list(checkout, 'folder');
    reads.push(first);
    await entered.promise;
    const second = editor.list(checkout, 'folder');
    reads.push(second);
    await Promise.resolve();
    assert.equal(calls, 1, 'Repeated expansion must not start duplicate filesystem work');
    release.release();
    assert.deepEqual(await first, await second);
    await f.client.command('mutate', {
      checkout,
      clientId: 'listing-source',
      id: 'new-file',
      kind: 'create-file',
      sources: [],
      destination: 'folder/new.ts',
      text: 'new',
    });
    assert(
      (await editor.list(checkout, 'folder')).entries.some(
        (entry) => entry.path === 'folder/new.ts',
      ),
    );
    assert.equal(calls, 2);
  } finally {
    release.release();
    await Promise.allSettled(reads);
    await editor.dispose();
    await f.dispose();
  }
});

test('first folder listing is visible while Git is held, and stale classifications cannot replace newer results', async () => {
  const f = await fixture('listing-isolation-source', false);
  const entered = held(),
    release = held(),
    returned = held(),
    classified = held();
  let hold = false;
  let obsoleteSignal: AbortSignal | undefined;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-isolation',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (hold && name === 'getIgnoredPaths' && (input as { path: string }).path === '') {
          hold = false;
          obsoleteSignal = options?.signal;
          const listing = await f.client.command(name, input, options);
          (listing as { paths: string[] }).paths = [];
          entered.release();
          await release.promise;
          returned.release();
          return listing;
        }
        return f.client.command(name, input, options);
      },
    },
  });
  // Every value c.ts's classification takes after Git first marks it ignored.
  const seen: (boolean | undefined)[] = [];
  const off = editor.subscribe(() => {
    const ignored = editor
      .getSnapshot()
      .listings[fileKey(target(''))]?.entries.find((entry) => entry.path === 'c.ts')?.ignored;
    if (ignored) classified.release();
    if (seen.length || ignored) seen.push(ignored);
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.openCheckout(second.root);
    hold = true;
    editor.tree(checkout, { hideIgnoredFiles: true });
    const unfiltered = await editor.list(checkout);
    await entered.promise;
    assert(unfiltered.entries.some((entry) => entry.path === 'c.ts'));
    assert(unfiltered.entries.every((entry) => entry.ignored === undefined));
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target(''))].entries.some((entry) => entry.path === 'c.ts'),
    );
    const other = await editor.list(second);
    assert(other.entries.some((entry) => entry.path === 'c.ts'));
    assert.equal(obsoleteSignal?.aborted, false, 'Other checkouts retain their classification');
    await editor.list(checkout);
    // One superseded classification per folder keeps running, so refreshes cannot starve Git.
    assert.equal(obsoleteSignal?.aborted, false, 'A refresh keeps the running classification');
    await classified.promise;
    release.release();
    // The stale reply (nothing ignored) returns and is processed; it must not replace the newer one.
    await returned.promise;
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    await f.runtime.runPromise(Effect.yieldNow);
    assert.deepEqual([...new Set(seen)], [true], 'c.ts must stay ignored');
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target(''))].entries.find((entry) => entry.path === 'c.ts')?.ignored,
    );
    f.memory.failNext('listDirectory', 'Temporary listing failure');
    await assert.rejects(editor.list(checkout), /Temporary listing failure/);
    assert((await editor.list(checkout)).entries.some((entry) => entry.path === 'c.ts'));
  } finally {
    release.release();
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('filesystem changes refresh past a held folder read and older replies cannot replace fresh entries', async () => {
  const f = await fixture('listing-watcher-source', false);
  const entered = held(),
    release = held(),
    refreshed = held();
  let hold = false;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-watcher',
    client: {
      ...f.client,
      async command(name, input, options) {
        const result = await f.client.command(name, input, options);
        if (hold && name === 'listDirectory' && (input as { path: string }).path === 'folder') {
          hold = false;
          entered.release();
          await release.promise;
        }
        return result;
      },
    },
  });
  let pending: Promise<unknown> | undefined;
  const off = editor.subscribe(() => {
    if (
      editor
        .getSnapshot()
        .listings[fileKey(target('folder'))]?.entries.some(
          (entry) => entry.path === 'folder/new.ts',
        )
    )
      refreshed.release();
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    editor.tree(checkout, { expanded: ['folder'] });
    hold = true;
    pending = editor.list(checkout, 'folder');
    await entered.promise;
    await f.client.command('mutate', {
      checkout,
      clientId: 'listing-watcher-source',
      id: 'new-watched-file',
      kind: 'create-file',
      sources: [],
      destination: 'folder/new.ts',
      text: 'new',
    });
    await Promise.race([
      refreshed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('Folder refresh waited for an obsolete read')), 1000),
      ),
    ]);
    release.release();
    await pending;
    assert(
      editor
        .getSnapshot()
        .listings[fileKey(target('folder'))].entries.some(
          (entry) => entry.path === 'folder/new.ts',
        ),
    );
  } finally {
    release.release();
    await pending;
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('a watch that fails as Unavailable is watched again after the backoff and read again, and a refused one is reported', async () => {
  const f = await fixture('listing-rewatch-source', false);
  const watches: {
    receive: (event: WorkspaceEvent) => void;
    fail: (error: ApplicationError) => void;
  }[] = [];
  const reports: unknown[] = [];
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-rewatch',
    watchRetryMs: [0],
    client: {
      ...f.client,
      watch(input, receive, fail) {
        watches.push({ receive, fail });
        return async () => {};
      },
    },
  });
  const off = editor.subscribe(() => {
    const errors = editor.getSnapshot().errors;
    if (errors.length) reports.push(...errors);
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    editor.tree(checkout, { expanded: ['folder'] });
    await editor.list(checkout, 'folder');
    await f.client.command('mutate', {
      checkout,
      clientId: 'listing-rewatch-source',
      id: 'missed-while-down',
      kind: 'create-file',
      sources: [],
      destination: 'folder/missed.ts',
      text: 'new',
    });
    watches[0].fail(new ApplicationError({ code: 'Unavailable', message: 'Daemon restarted.' }));
    // The second watch replaces the failed one, and the change it missed is read.
    await until(() => watches.length === 2);
    await until(() =>
      editor
        .getSnapshot()
        .listings[fileKey(target('folder'))]?.entries.some(
          (entry) => entry.path === 'folder/missed.ts',
        ),
    );
    assert.equal(reports.length, 0);
    // The backoff has run out: the next failure is reported instead of watched again.
    watches[1].fail(new ApplicationError({ code: 'Unavailable', message: 'Still down.' }));
    await until(() => reports.length > 0);
    assert.equal(watches.length, 2);
  } finally {
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('ignore failures keep files visible, retries can classify, and disposal cancels held metadata', async () => {
  const f = await fixture('listing-ignore-lifetime-source', false);
  const failed = held(),
    entered = held(),
    release = held(),
    classified = held();
  let mode: 'fail' | 'classify' | 'hold' = 'fail';
  let signal: AbortSignal | undefined;
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-ignore-lifetime',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name === 'getIgnoredPaths' && (input as { path: string }).path === 'folder') {
          if (mode === 'fail') {
            f.memory.failNext('getIgnoredPaths', 'Ignore classification failed');
          } else if (mode === 'hold') {
            signal = options?.signal;
            entered.release();
            await release.promise;
          }
        }
        return f.client.command(name, input, options);
      },
    },
  });
  const off = editor.subscribe(() => {
    const state = editor.getSnapshot();
    if (state.errors.some((error) => error.includes('Ignore classification failed')))
      failed.release();
    if (state.listings[fileKey(target('folder'))]?.entries[0]?.ignored === false)
      classified.release();
  });
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    assert.equal((await editor.list(checkout, 'folder')).entries[0].path, 'folder/nested.ts');
    await failed.promise;
    assert.equal(editor.getSnapshot().listings[fileKey(target('folder'))].entries.length, 1);
    mode = 'classify';
    await editor.list(checkout, 'folder');
    await classified.promise;
    mode = 'hold';
    await editor.list(checkout, 'folder');
    await entered.promise;
    await editor.dispose();
    assert.equal(signal?.aborted, true);
    const disposed = editor.getSnapshot();
    release.release();
    await f.runtime.runPromise(Effect.yieldNow);
    assert.equal(editor.getSnapshot(), disposed);
  } finally {
    release.release();
    off();
    await editor.dispose();
    await f.dispose();
  }
});

test('a refreshed listing keeps its ignored classification until Git classifies it again', async () => {
  const f = await fixture('listing-ignored-refresh', false);
  const classification = () =>
    f.editor
      .getSnapshot()
      .listings[fileKey(target(''))]?.entries.find((entry) => entry.path === 'c.ts')?.ignored;
  const seen: (boolean | undefined)[] = [];
  try {
    await f.editor.list(checkout);
    await f.runtime.runPromise(Effect.yieldNow);
    while (classification() === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(classification(), true);
    const off = f.editor.subscribe(() => seen.push(classification()));
    try {
      // An unrelated change on disk relists the folder, as a watcher refresh does.
      f.memory.externalWrite(target('a.ts'), 'changed elsewhere');
      await f.editor.refresh(checkout);
    } finally {
      off();
    }
    assert(seen.length > 0, 'The refresh must publish its listing');
    assert.deepEqual([...new Set(seen)], [true], 'c.ts must not flash as unignored');
  } finally {
    await f.dispose();
  }
});

type Snapshots = { getSnapshot(): EditorSnapshot };
/** c.ts's Git classification in the root listing. */
const readIgnored = (editor: Snapshots) =>
  editor.getSnapshot().listings[fileKey(target(''))]?.entries.find((entry) => entry.path === 'c.ts')
    ?.ignored;
async function expectClassification(editor: Snapshots, expected: boolean | undefined) {
  for (let i = 0; i < 200 && readIgnored(editor) !== expected; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(readIgnored(editor), expected);
}

test('refreshes faster than Git cannot keep a file dimmed after a .gitignore edit', async () => {
  const f = await fixture('listing-ignored-starved-source', false);
  // What Git answers, and the held answers in the order they were asked.
  let ignoredPaths = ['c.ts'],
    hold = false,
    entered = held();
  const asked: { signal?: AbortSignal; release(): void }[] = [];
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-ignored-starved',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (name !== 'getIgnoredPaths' || (input as { path: string }).path !== '')
          return f.client.command(name, input, options);
        const answer = { paths: ignoredPaths.slice() };
        if (hold) {
          const release = held();
          asked.push({ signal: options?.signal, release: release.release });
          entered.release();
          await release.promise;
        }
        return answer as never;
      },
    },
  });
  const refresh = async () => {
    entered = held();
    await editor.list(checkout);
    await entered.promise;
  };
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.list(checkout);
    await expectClassification(editor, true);
    // .gitignore no longer lists c.ts, and each refresh arrives before Git answers the last.
    ignoredPaths = [];
    hold = true;
    await refresh();
    await refresh();
    await refresh();
    assert.equal(readIgnored(editor), true, 'Listings carry it over meanwhile');
    assert.equal(asked[0].signal?.aborted, false, 'The first superseded classification runs on');
    assert.equal(asked[1].signal?.aborted, true, 'Later superseded ones are cancelled');
    asked[0].release();
    await expectClassification(editor, false);
    asked[2].release();
    await expectClassification(editor, false);
  } finally {
    for (const call of asked) call.release();
    await editor.dispose();
    await f.dispose();
  }
});

test('a failed Git classification leaves refreshed entries unclassified, not stale', async () => {
  const f = await fixture('listing-ignored-failure', false);
  try {
    await f.editor.list(checkout);
    await expectClassification(f.editor, true);
    f.memory.failNext('getIgnoredPaths', 'Ignore classification failed');
    await f.editor.list(checkout);
    await expectClassification(f.editor, undefined);
    assert(
      f.editor
        .getSnapshot()
        .listings[fileKey(target(''))].entries.some((entry) => entry.path === 'c.ts'),
      'The files stay listed',
    );
    // The next refresh classifies again.
    await f.editor.list(checkout);
    await expectClassification(f.editor, true);
  } finally {
    await f.dispose();
  }
});

test('a kept classification that reports an error does not stand in for a failed newer one', async () => {
  const f = await fixture('listing-ignored-soft-error-source', false);
  let hold = false,
    entered = held();
  const asked: {
    answer(value: { paths: string[]; error?: string }): void;
    fail(error: Error): void;
    returned: Promise<void>;
  }[] = [];
  const editor = await acquireEditor(f.runtime, {
    clientId: 'listing-ignored-soft-error',
    client: {
      ...f.client,
      watch: () => async () => {},
      async command(name, input, options) {
        if (!hold || name !== 'getIgnoredPaths' || (input as { path: string }).path !== '')
          return f.client.command(name, input, options);
        const returned = held();
        const reply = new Promise<{ paths: string[]; error?: string }>((resolve, reject) =>
          asked.push({ answer: resolve, fail: reject, returned: returned.promise }),
        );
        entered.release();
        try {
          return (await reply) as never;
        } finally {
          returned.release();
        }
      },
    },
  });
  const refresh = async () => {
    entered = held();
    await editor.list(checkout);
    await entered.promise;
  };
  try {
    await editor.load();
    await editor.openCheckout(checkout.root);
    await editor.list(checkout);
    await expectClassification(editor, true);
    hold = true;
    await refresh();
    await refresh();
    // The kept classification answers with an error, which classifies nothing.
    asked[0].answer({ paths: [], error: 'Git timed out' });
    await asked[0].returned;
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(readIgnored(editor), true);
    // The newest one fails outright: nothing classified the listing, so it shows unclassified.
    asked[1].fail(new Error('Git failed'));
    await expectClassification(editor, undefined);
  } finally {
    for (const call of asked) call.answer({ paths: [] });
    await editor.dispose();
    await f.dispose();
  }
});
