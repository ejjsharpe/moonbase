import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatFileIndex, type ChatFileListingRun } from '../src/files.ts';
import { LocalPiRuntimeLive } from '../src/index.ts';
import { fixture, session } from './runtime-fixture.ts';

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

test('a fixed host searches only its working folder, for new and existing chats', async (t) => {
  const f = await fixture(t);
  // Git lists the folder whether or not this machine has ripgrep.
  execFileSync('git', ['init', '-q'], { cwd: f.config.cwd });
  const client = f.client;
  await writeFile(join(f.config.cwd, 'notes.md'), 'x');
  const cwd = await realpath(f.config.cwd);
  assert(
    paths(await client.command('findChatFiles', { session, cwd, query: 'notes' })).includes(
      'notes.md',
    ),
  );
  await assert.rejects(
    client.command('findChatFiles', { session, cwd: tmpdir(), query: '' }),
    (error) => ApplicationError.is(error) && error.code === 'Unauthorized',
  );
  await assert.rejects(
    client.command('findChatFiles', {
      session: { ...session, actorId: 'other' },
      cwd,
      query: '',
    }),
    (error) => ApplicationError.is(error) && error.code === 'Unauthorized',
  );
  const target = await f.create();
  assert(
    paths(await client.command('findChatFiles', { target, query: 'notes' })).includes('notes.md'),
  );
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
