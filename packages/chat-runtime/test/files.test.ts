import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime, type Duration, type Scope } from 'effect';
import { TestClock } from 'effect/testing';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { ChildProcessSpawner } from 'effect/process';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/chat/clients';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { FolderRefusedError } from '@moonbase/contracts/folder-errors';
import {
  ListingError,
  makeChatFileIndex,
  type ChatFileIndexOptions,
  type ChatFileListingRun,
} from '../src/files.ts';
import { fixture, isRunning, localPiRuntime, session } from './runtime-fixture.ts';

const which = (name: string) => {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const ripgrep = process.env.MOONBASE_TEST_RIPGREP ?? which('rg');
const missing = join(tmpdir(), 'moonbase-no-such-ripgrep');

async function folder(t: { after: (fn: () => Promise<void>) => void }, git = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of [
    ['README.md', 'readme'],
    ['src/app/main.ts', 'main'],
    ['src/app/My notes.md', 'notes'],
    ['src/ignored.log', 'ignored'],
    ['node_modules/pkg/index.js', 'dependency'],
    ['.gitignore', '*.log\n'],
    ['.env.example', 'KEY='],
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'README.md'], { cwd: root });
  }
  return root;
}
const paths = (result: { matches: { path: string }[] }) => result.matches.map((m) => m.path);
/** Runs a test program on the platform's services and a TestClock the test moves. */
const runIndexTest = <A, E>(
  program: Effect.Effect<A, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
  );
/** An index over `options` whose searches the test awaits as promises, on a TestClock. */
const withIndex = <A>(
  options: ChatFileIndexOptions,
  use: (index: {
    find: (cwd: string, query: string) => Promise<FindResult>;
    /** Moves the TestClock the index's budgets and freshness run on. */
    advance: (duration: Duration.Input) => Promise<void>;
  }) => Promise<A>,
) =>
  runIndexTest(
    Effect.gen(function* () {
      const index = yield* makeChatFileIndex(options);
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      return yield* Effect.promise(() =>
        use({
          find: (cwd, query) => run(index.find(cwd, query)),
          advance: (duration) => run(TestClock.adjust(duration)),
        }),
      );
    }),
  );
type FindResult = {
  query: string;
  matches: { path: string; positions: number[] }[];
  partial: boolean;
};
const missingCommand = () => new ListingError({ reason: 'missing', output: Buffer.alloc(0) });
const expected = [
  '.env.example',
  '.gitignore',
  'README.md',
  'src/app/main.ts',
  'src/app/My notes.md',
];

test('without ripgrep, Git lists tracked and unignored files, never dependencies or ignored files', async (t) => {
  const root = await folder(t);
  await withIndex({ ripgrepExecutable: missing }, async (index) => {
    const all = await index.find(root, '');
    // An empty query lists the shallowest files first.
    assert.deepEqual(paths(all), expected);
    assert.equal(all.partial, false);
    const found = await index.find(root, 'mainp');
    assert.deepEqual(paths(found), []);
    const main = await index.find(root, 'appmain');
    assert.equal(main.matches[0]?.path, 'src/app/main.ts');
    assert.deepEqual(main.query, 'appmain');
    assert(main.matches[0]!.positions.length > 0);
  });
});

// CI provides ripgrep, so there a missing one fails rather than skips.
const skipRipgrep = !ripgrep && !process.env.CI && 'ripgrep is not installed';
test('ripgrep lists the same files with its ignore rules', { skip: skipRipgrep }, async (t) => {
  assert(ripgrep, 'Set MOONBASE_TEST_RIPGREP to the ripgrep scripts/prepare-ripgrep.mjs prepares.');
  const root = await folder(t);
  await withIndex({ ripgrepExecutable: ripgrep }, async (index) => {
    assert.deepEqual(paths(await index.find(root, '')), expected);
    assert.equal((await index.find(root, 'rdme')).matches[0]?.path, 'README.md');
  });
});

test('search fails clearly when neither ripgrep nor a Git checkout is available', async (t) => {
  const root = await folder(t, false);
  await withIndex({ ripgrepExecutable: missing }, (index) =>
    assert.rejects(index.find(root, ''), {
      _tag: 'ChatUnavailableError',
      reason: 'file-search',
    }),
  );
  // Without the command-line tools, macOS's Git stub would offer to install them: it never runs.
  const runs: string[] = [];
  const checkout = await folder(t);
  await withIndex(
    {
      run: (executable) => {
        runs.push(executable);
        return Effect.fail(missingCommand());
      },
      canRunGit: Effect.succeed(false),
    },
    (index) =>
      assert.rejects(index.find(checkout, ''), {
        _tag: 'ChatUnavailableError',
        reason: 'file-search',
      }),
  );
  assert.deepEqual(runs, ['rg']);
});

test('one listing serves a burst of queries; it is refreshed later and a failure is not kept', async () => {
  let runs = 0,
    fail = false;
  const run: ChatFileListingRun = () =>
    Effect.suspend(() => {
      runs++;
      if (fail)
        return Effect.fail(
          new ListingError({ reason: 'exited', status: 3, output: Buffer.alloc(0) }),
        );
      return Effect.succeed({
        bytes: Buffer.from('b.ts\0./a.ts\0a.ts\0dir/c"quoted.ts\0dir/nested/d.ts\0'),
        truncated: false,
      });
    });
  await withIndex({ run }, async (index) => {
    const [first, second] = await Promise.all([index.find('/work', ''), index.find('/work', 'd')]);
    assert.equal(runs, 1);
    // Duplicates collapse, and a path that cannot be a mention is not offered.
    assert.deepEqual(paths(first), ['a.ts', 'b.ts', 'dir/nested/d.ts']);
    assert.equal(second.matches[0]?.path, 'dir/nested/d.ts');
    await index.advance('4 seconds');
    await index.find('/work', 'a');
    assert.equal(runs, 1);
    await index.advance('2 seconds');
    fail = true;
    await assert.rejects(index.find('/work', 'a'));
    fail = false;
    await index.find('/work', 'a');
    assert.equal(runs, 3);
  });
});

test('a listing cut short by its size or time budget is searched partially', async () => {
  // The budget stopped the listing partway through an entry.
  await withIndex(
    { run: () => Effect.succeed({ bytes: Buffer.from('a.ts\0b.ts\0c.t'), truncated: true }) },
    async (index) => {
      const result = await index.find('/work', '');
      assert.deepEqual(paths(result), ['a.ts', 'b.ts']);
      assert.equal(result.partial, true);
    },
  );
});

test('results stop at 50 and say they are partial', async () => {
  const files = Array.from({ length: 80 }, (_, n) => `file${String(n).padStart(2, '0')}.ts`);
  await withIndex(
    { run: () => Effect.succeed({ bytes: Buffer.from(files.join('\0')), truncated: false }) },
    async (index) => {
      const result = await index.find('/work', 'file');
      assert.equal(result.matches.length, 50);
      assert.equal(result.partial, true);
    },
  );
});

test('a local chat searches its own folder; a new chat only an approved one', async (t) => {
  const approved = await folder(t),
    other = await folder(t);
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels();
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    localPiRuntime({
      ...session,
      databasePath: join(approved, '..', `${approved.split('/').at(-1)}.sqlite`),
      models,
      ripgrepExecutable: missing,
      approveFolder: async (cwd) => {
        if (cwd !== approved)
          throw new FolderRefusedError({ refusal: 'not-approved', use: 'search' });
      },
    }),
  );
  t.after(async () => {
    await runtime.dispose();
    await rm(join(approved, '..', `${approved.split('/').at(-1)}.sqlite`), { force: true });
  });
  const client = makeChatClient(runtime);
  assert.deepEqual(
    paths(await client.command('findChatFiles', { session, cwd: approved, query: '' })),
    expected,
  );
  await assert.rejects(
    client.command('findChatFiles', { session, cwd: other, query: '' }),
    (error) => ApplicationError.is(error) && error.code === 'Unauthorized',
  );
  const { conversation } = await client.command('createChat', {
    session,
    requestId: 'create',
    title: 'Saved chat',
    settings: { cwd: approved, model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const result = await client.command('findChatFiles', {
    target: conversation.target,
    query: 'notes',
  });
  assert.equal(result.matches[0]?.path, 'src/app/My notes.md');
});

test('a Send carries the mentions its text spells', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  const receipt = await f.client.command('sendChat', {
    target,
    requestId: 'send',
    text: 'Read @README.md and @"docs/My notes.md"',
    mentions: [{ path: 'README.md' }, { path: 'docs/My notes.md' }],
  });
  assert.equal(receipt.admission, 'admitted');
});

/**
 * Writes a listing command that prints part of the folder, then stalls like ripgrep or Git on a
 * hung mount, with a child that ignores SIGTERM. The child holds no pipe unless `childHoldsOutput`,
 * and the listing itself ignores SIGTERM when `ignoresTerm`. It records its pid in `pids` and the
 * child's in `children`.
 */
async function writeStalledListing(
  bin: string,
  name: string,
  { ignoresTerm = false, childHoldsOutput = false } = {},
) {
  const command = join(bin, name);
  await writeFile(
    command,
    `#!/bin/sh
${ignoresTerm ? 'trap "" TERM' : ''}
echo $$ >> '${join(bin, 'pids')}'
printf 'README.md\\0src/app/main.ts\\0'
sh -c 'trap "" TERM; exec sleep 60' < /dev/null ${childHoldsOutput ? '' : '> /dev/null 2>&1'} &
echo $! >> '${join(bin, 'children')}'
wait
`,
    { mode: 0o755 },
  );
  return command;
}
const readPid = async (path: string) =>
  Number((await readFile(path, 'utf8').catch(() => '')).trim()) || undefined;
async function waitForPid(path: string) {
  for (let i = 0; i < 500; i++) {
    const pid = await readPid(path);
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The listing never started its child');
}
const stopGrace = '200 millis';
/** Ends a stalled listing's time budget once the listing in `bin` has printed and started its child. */
async function expireBudget(bin: string, advance: (duration: Duration.Input) => Promise<void>) {
  await waitForPid(join(bin, 'children'));
  await advance('10 seconds');
}
/** The listing and its child are gone once the search returns: the whole group was stopped. */
async function assertListingStopped(bin: string) {
  const pid = await readPid(join(bin, 'pids')),
    child = await readPid(join(bin, 'children'));
  assert(pid && child, 'The listing never started its child');
  for (let i = 0; i < 50 && (isRunning(pid) || isRunning(child)); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(!isRunning(pid), 'The stalled listing outlived its budget');
  assert(!isRunning(child), "The stalled listing's child outlived its budget");
}

test('a cancelled search returns at once, and its stalled listing is stopped at its time budget', async (t) => {
  const root = await folder(t, false),
    bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
  const pids = join(bin, 'pids'),
    stalled = await writeStalledListing(bin, 'rg');
  // The runtime's clock is a TestClock the test moves to end the listing's budget.
  const runtime = ManagedRuntime.make(
    Layer.merge(
      localPiRuntime({
        ...session,
        databasePath: join(bin, 'chat.sqlite'),
        models: createModels(),
        ripgrepExecutable: stalled,
        fileListingTiming: { stopGrace },
        approveFolder: async () => {},
      }),
      TestClock.layer(),
    ),
  );
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
  const client = makeChatClient(runtime),
    input = { session, cwd: root, query: '' };
  const abort = new AbortController(),
    cancelled = client.command('findChatFiles', input, { signal: abort.signal });
  const pid = await waitForPid(pids);
  abort.abort();
  // The listing stays stalled until its budget, so a rejection means cancelling did not wait for it.
  await assert.rejects(cancelled, { code: 'Cancelled' });
  // The listing is shared, so cancelling one search leaves it to finish for the next.
  assert(isRunning(pid));
  const searched = client.command('findChatFiles', input);
  await expireBudget(bin, (duration) => runtime.runPromise(TestClock.adjust(duration)));
  const result = await searched;
  assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
  assert.equal(result.partial, true);
  await assertListingStopped(bin);
  assert.equal((await readFile(pids, 'utf8')).trim(), String(pid), 'The search listed twice');
});

test('a stalled Git listing is stopped with its children at its time budget', async (t) => {
  const root = await folder(t),
    bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const gitExecutable = await writeStalledListing(bin, 'git');
  await withIndex(
    { ripgrepExecutable: missing, gitExecutable, timing: { stopGrace } },
    async (index) => {
      const searched = index.find(root, '');
      await expireBudget(bin, index.advance);
      const result = await searched;
      assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
      assert.equal(result.partial, true);
    },
  );
  await assertListingStopped(bin);
});

test('a listing that ignores SIGTERM, or whose child holds its output, is killed after the grace period', async (t) => {
  const root = await folder(t);
  const search = async (options: { ignoresTerm?: boolean; childHoldsOutput?: boolean }) => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
    t.after(() => rm(bin, { recursive: true, force: true }));
    const gitExecutable = await writeStalledListing(bin, 'git', options);
    await withIndex(
      { ripgrepExecutable: missing, gitExecutable, timing: { stopGrace } },
      async (index) => {
        const searched = index.find(root, '');
        await expireBudget(bin, index.advance);
        const result = await searched;
        assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
        assert.equal(result.partial, true);
      },
    );
    await assertListingStopped(bin);
  };
  // Both wait out the same grace, so they run together.
  await Promise.all([search({ ignoresTerm: true }), search({ childHoldsOutput: true })]);
});

test('disposing the runtime stops its running listings and waits for them to exit', async (t) => {
  const root = await folder(t, false),
    bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
  const pids = join(bin, 'pids'),
    stalled = await writeStalledListing(bin, 'rg', { ignoresTerm: true, childHoldsOutput: true });
  const runtime = ManagedRuntime.make(
    localPiRuntime({
      ...session,
      databasePath: join(bin, 'chat.sqlite'),
      models: createModels(),
      ripgrepExecutable: stalled,
      fileListingTiming: { stopGrace },
      approveFolder: async () => {},
    }),
  );
  let disposed = false;
  t.after(async () => {
    try {
      if (!disposed) await runtime.dispose();
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
  const client = makeChatClient(runtime);
  const search = client.command('findChatFiles', { session, cwd: root, query: '' });
  search.catch(() => {});
  let pid: number | undefined, child: number | undefined;
  for (let i = 0; i < 500 && !(pid && child); i++) {
    [pid, child] = [await readPid(pids), await readPid(join(bin, 'children'))];
    if (!(pid && child)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(pid && child, 'The listing never started its child');
  const started = Date.now();
  disposed = true;
  await runtime.dispose();
  // Well inside the 10 s listing budget: the listing was stopped, not left to time out.
  assert(Date.now() - started < 5_000, 'Disposing waited for the listing budget');
  assert(!isRunning(pid), 'The listing outlived its runtime');
  assert(!isRunning(child), "The listing's child outlived its runtime");
});
