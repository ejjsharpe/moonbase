import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatFileIndex, type ChatFileListingRun } from '../src/files.ts';
import { LocalPiRuntimeLive } from '../src/index.ts';
import { fixture, isRunning, session } from './runtime-fixture.ts';

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
const expected = [
  '.env.example',
  '.gitignore',
  'README.md',
  'src/app/main.ts',
  'src/app/My notes.md',
];

test('without ripgrep, Git lists tracked and unignored files, never dependencies or ignored files', async (t) => {
  const root = await folder(t);
  const index = new ChatFileIndex({ ripgrepExecutable: missing });
  const all = await index.find(root, '');
  // An empty query lists the shallowest files first.
  assert.deepEqual(paths(all), expected);
  assert.equal(all.partial, false);
  const found = await index.find(root, 'mainp');
  assert.deepEqual(paths(found), []);
  const main = await index.find(root, 'appmain');
  assert.equal(main.matches[0]?.path, 'src/app/main.ts');
  assert.deepEqual(main.query, 'appmain');
  assert(main.matches[0].positions.length > 0);
});

test('ripgrep lists the same files with its ignore rules', { skip: !ripgrep }, async (t) => {
  const root = await folder(t);
  const index = new ChatFileIndex({ ripgrepExecutable: ripgrep });
  assert.deepEqual(paths(await index.find(root, '')), expected);
  assert.equal((await index.find(root, 'rdme')).matches[0]?.path, 'README.md');
});

test('search fails clearly when neither ripgrep nor a Git checkout is available', async (t) => {
  const root = await folder(t, false);
  const index = new ChatFileIndex({ ripgrepExecutable: missing });
  await assert.rejects(
    index.find(root, ''),
    (error) => ApplicationError.is(error) && error.code === 'Unavailable',
  );
});

test('one listing serves a burst of queries; it is refreshed later and a failure is not kept', async () => {
  let now = 0,
    runs = 0,
    fail = false;
  const run: ChatFileListingRun = async () => {
    runs++;
    if (fail) throw Object.assign(Error('crashed'), { code: 2 });
    return Buffer.from('b.ts\0./a.ts\0a.ts\0dir/c"quoted.ts\0dir/nested/d.ts\0');
  };
  const index = new ChatFileIndex({ run, now: () => now });
  const [first, second] = await Promise.all([index.find('/work', ''), index.find('/work', 'd')]);
  assert.equal(runs, 1);
  // Duplicates collapse, and a path that cannot be a mention is not offered.
  assert.deepEqual(paths(first), ['a.ts', 'b.ts', 'dir/nested/d.ts']);
  assert.equal(second.matches[0]?.path, 'dir/nested/d.ts');
  now += 4_000;
  await index.find('/work', 'a');
  assert.equal(runs, 1);
  now += 2_000;
  fail = true;
  await assert.rejects(index.find('/work', 'a'));
  fail = false;
  await index.find('/work', 'a');
  assert.equal(runs, 3);
});

test('a listing cut short by its size or time budget is searched partially', async () => {
  for (const failure of [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { killed: true }]) {
    const index = new ChatFileIndex({
      run: async () => {
        // The budget stopped the listing partway through an entry.
        throw Object.assign(Error('stopped'), failure, { stdout: Buffer.from('a.ts\0b.ts\0c.t') });
      },
    });
    const result = await index.find('/work', '');
    assert.deepEqual(paths(result), ['a.ts', 'b.ts']);
    assert.equal(result.partial, true);
  }
});

test('results stop at 50 and say they are partial', async () => {
  const files = Array.from({ length: 80 }, (_, n) => `file${String(n).padStart(2, '0')}.ts`);
  const index = new ChatFileIndex({ run: async () => Buffer.from(files.join('\0')) });
  const result = await index.find('/work', 'file');
  assert.equal(result.matches.length, 50);
  assert.equal(result.partial, true);
});

test('a local chat searches its own folder; a new chat only an approved one', async (t) => {
  const approved = await folder(t),
    other = await folder(t);
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels();
  models.setProvider(faux.provider);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      databasePath: join(approved, '..', `${approved.split('/').at(-1)}.sqlite`),
      models,
      ripgrepExecutable: missing,
      approveFolder: async (cwd) => {
        if (cwd !== approved)
          throw new ApplicationError({ code: 'Unauthorized', message: 'Not approved.' });
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

test('a Send carries mentions the text spells, and refuses ones it does not', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  const receipt = await f.client.command('sendChat', {
    target,
    requestId: 'send',
    text: 'Read @README.md and @"docs/My notes.md"',
    mentions: [{ path: 'README.md' }, { path: 'docs/My notes.md' }],
  });
  assert.equal(receipt.admission, 'admitted');
  await assert.rejects(
    f.client.command('sendChat', {
      target,
      requestId: 'send-2',
      text: 'Read the readme',
      mentions: [{ path: 'README.md' }],
    }),
    (error) => ApplicationError.is(error) && error.code === 'InvalidInput',
  );
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
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      databasePath: join(bin, 'chat.sqlite'),
      models: createModels(),
      ripgrepExecutable: stalled,
      approveFolder: async () => {},
    }),
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
  let pid: number | undefined;
  for (let i = 0; i < 500 && !pid; i++) {
    pid = await readPid(pids);
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(pid, 'The listing never started');
  const started = Date.now();
  abort.abort();
  await assert.rejects(cancelled, { code: 'Cancelled' });
  assert(Date.now() - started < 1_000, 'Cancelling waited for the listing');
  // The listing is shared, so cancelling one search leaves it to finish for the next.
  assert(isRunning(pid));
  const result = await client.command('findChatFiles', input);
  assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
  assert.equal(result.partial, true);
  await assertListingStopped(bin);
  assert.equal((await readFile(pids, 'utf8')).trim(), String(pid), 'The search listed twice');
});

test('a stalled Git listing is stopped with its children at its time budget', async (t) => {
  const root = await folder(t),
    bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const index = new ChatFileIndex({
    ripgrepExecutable: missing,
    gitExecutable: await writeStalledListing(bin, 'git'),
  });
  const result = await index.find(root, '');
  assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
  assert.equal(result.partial, true);
  await assertListingStopped(bin);
});

test(
  'a listing that ignores SIGTERM, or whose child holds its output, is killed after the grace period',
  { timeout: 30_000 },
  async (t) => {
    const root = await folder(t);
    const search = async (options: { ignoresTerm?: boolean; childHoldsOutput?: boolean }) => {
      const bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
      t.after(() => rm(bin, { recursive: true, force: true }));
      const index = new ChatFileIndex({
        ripgrepExecutable: missing,
        gitExecutable: await writeStalledListing(bin, 'git', options),
      });
      const result = await index.find(root, '');
      assert.deepEqual(paths(result), ['README.md', 'src/app/main.ts']);
      assert.equal(result.partial, true);
      await assertListingStopped(bin);
    };
    // Both wait out the same 10 s budget, so they run together.
    await Promise.all([search({ ignoresTerm: true }), search({ childHoldsOutput: true })]);
  },
);

test('disposing the runtime stops its running listings and waits for them to exit', async (t) => {
  const root = await folder(t, false),
    bin = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-files-bin-')));
  const pids = join(bin, 'pids'),
    stalled = await writeStalledListing(bin, 'rg', { ignoresTerm: true, childHoldsOutput: true });
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      ...session,
      databasePath: join(bin, 'chat.sqlite'),
      models: createModels(),
      ripgrepExecutable: stalled,
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
