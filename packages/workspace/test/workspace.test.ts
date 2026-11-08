import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  linkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';

import { fixture, rejects } from './workspace-fixture.ts';

test('entries-only listings bypass Git ignore policy and leave classification unknown', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'visible.ts'), 'visible');
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.gitignore'));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const listing = await f.client.command('listDirectory', {
      checkout,
      path: '',
      includeIgnoredStatus: false,
    });
    assert.equal(listing.partial, false);
    assert.equal(listing.error, undefined);
    assert.deepEqual(listing.entries, [{ path: 'visible.ts', directory: false }]);
    const ignored = await f.client.command('getIgnoredPaths', {
      checkout,
      path: '',
      paths: ['visible.ts'],
    });
    assert.match(ignored.error!, /Git ignore policy unavailable/);
    assert.deepEqual(ignored.paths, []);
    await assert.rejects(
      f.client.command('listDirectory', {
        checkout,
        path: '',
        includeIgnoredStatus: false,
        hideIgnored: true,
      }),
      rejects('InvalidInput'),
    );
  } finally {
    await f.close();
  }
});

test('ignore classification validates exact checkout and immediate child paths', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(join(f.root, '.gitignore'), 'hidden.ts\n');
    writeFileSync(join(f.root, 'src/hidden.ts'), 'hidden');
    writeFileSync(join(f.root, 'src/visible.ts'), 'visible');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    assert.deepEqual(
      await f.client.command('getIgnoredPaths', {
        checkout,
        path: 'src',
        paths: ['src/hidden.ts', 'src/visible.ts'],
      }),
      { paths: ['src/hidden.ts'] },
    );
    for (const paths of [
      ['../outside'],
      ['.git/config'],
      ['src/nested/file.ts'],
      ['other/file.ts'],
      Array(20001).fill('src/hidden.ts'),
    ])
      await assert.rejects(
        f.client.command('getIgnoredPaths', { checkout, path: 'src', paths }),
        rejects('InvalidInput'),
      );
    await assert.rejects(
      f.client.command('getIgnoredPaths', {
        checkout: { ...checkout, hostId: 'remote' },
        path: 'src',
        paths: ['src/hidden.ts'],
      }),
      rejects('Unauthorized'),
    );
  } finally {
    await f.close();
  }
});

test('browsing a small folder does not scan unrelated project files', async (t) => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(join(f.root, 'src/visible.ts'), 'visible');
    writeFileSync(join(f.root, 'src/hidden.ts'), 'hidden');
    mkdirSync(join(f.root, 'src-fast'));
    writeFileSync(join(f.root, 'src-fast/visible.ts'), 'visible');
    writeFileSync(join(f.root, 'src-fast/hidden.ts'), 'hidden');
    writeFileSync(join(f.root, '.gitignore'), 'hidden.ts\n');
    mkdirSync(join(f.root, 'unrelated'));
    for (let index = 0; index < 20100; index++)
      linkSync(join(f.root, 'src/visible.ts'), join(f.root, 'unrelated', `${index}.ts`));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const fastStart = performance.now();
    const fast = await f.client.command('listDirectory', {
      checkout,
      path: 'src-fast',
      includeIgnoredStatus: false,
    });
    t.diagnostic(
      `First entries-only listing with 20,100 unrelated files: ${(performance.now() - fastStart).toFixed(1)} ms`,
    );
    assert.equal(fast.entries.length, 2);
    assert(fast.entries.every((entry) => entry.ignored === undefined));
    const start = performance.now();
    const listing = await f.client.command('listDirectory', {
      checkout,
      path: 'src',
      hideIgnored: true,
    });
    t.diagnostic(
      `Small-folder listing with 20,100 unrelated files: ${(performance.now() - start).toFixed(1)} ms`,
    );
    assert.equal(listing.partial, false, listing.error ?? 'Unexpected partial listing');
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ['src/visible.ts'],
    );
  } finally {
    await f.close();
  }
});

test('folder listings validate only applicable Git ignore policies and retain policy errors', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src/deep'), { recursive: true });
    mkdirSync(join(f.root, 'unrelated'));
    writeFileSync(join(f.root, '.gitignore'), '*.log\nhidden.ts\n');
    writeFileSync(join(f.root, 'src/.gitignore'), '!hidden.ts\n');
    for (const name of ['visible.ts', 'hidden.ts', 'hidden.log'])
      writeFileSync(join(f.root, 'src/deep', name), name);
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, 'unrelated/.gitignore'));
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.ignore'));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const list = () =>
      f.client.command('listDirectory', { checkout, path: 'src/deep', hideIgnored: true });
    const listing = await list();
    assert.equal(listing.partial, false, listing.error ?? 'Unexpected partial listing');
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ['src/deep/hidden.ts', 'src/deep/visible.ts'],
    );
    writeFileSync(join(f.root, 'src/deep/.gitignore'), 'hidden.ts\n');
    assert(!(await list()).entries.some((entry) => entry.path === 'src/deep/hidden.ts'));
    for (const policy of [
      'src/deep/.gitignore',
      'src/.gitignore',
      '.gitignore',
      '.git/info/exclude',
    ]) {
      const location = join(f.root, policy);
      const original = readFileSync(location);
      rmSync(location);
      symlinkSync(join(f.base, 'outside-ignore'), location);
      const unavailable = await list();
      assert.equal(unavailable.partial, true, policy);
      assert.match(unavailable.error!, /Git ignore policy unavailable/);
      assert.equal(
        unavailable.entries.filter((entry) => /\.(ts|log)$/.test(entry.path)).length,
        3,
        'Policy failure must show entries with an observable error',
      );
      rmSync(location);
      writeFileSync(location, original);
    }
  } finally {
    await f.close();
  }
});

test('local/remote and root replacement identities, traversal, symlinks, binary, size and hard-link save boundaries reject', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    writeFileSync(join(f.base, 'secret'), 'secret');
    symlinkSync(join(f.base, 'secret'), join(f.root, 'link'));
    writeFileSync(join(f.root, 'binary'), Buffer.from([0, 12]));
    writeFileSync(join(f.root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    for (const p of [
      '../secret',
      '.git/config',
      'a/../file.txt',
      '/file.txt',
      'link',
      'binary',
      'large',
    ])
      await assert.rejects(f.client.command('readFile', { checkout, path: p }));
    await assert.rejects(
      f.client.command('readFile', {
        checkout: { ...checkout, hostId: 'remote' },
        path: 'file.txt',
      }),
      rejects('Unauthorized'),
    );
    const disk = await f.client.command('readFile', { checkout, path: 'file.txt' });
    linkSync(join(f.root, 'file.txt'), join(f.root, 'hard-link'));
    await assert.rejects(
      f.client.command('saveFile', {
        target: { checkout, path: 'file.txt' },
        clientId: 'a',
        requestId: 'hard',
        text: 'new',
        expectedVersion: disk.version,
      }),
    );
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'disk');
    renameSync(f.root, f.root + '-old');
    mkdirSync(f.root);
    writeFileSync(join(f.root, 'file.txt'), 'wrong checkout');
    await assert.rejects(f.client.command('readFile', { checkout, path: 'file.txt' }));
  } finally {
    await f.close();
  }
});

test('Git staged and unstaged originals both compare against the current working document, lookup and ignore filtering work', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'file.txt'), 'HEAD');
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', [
        '-C',
        f.root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ]);
    git(['add', '.']);
    git(['commit', '-qm', 'initial']);
    writeFileSync(join(f.root, 'file.txt'), 'index');
    git(['add', '.']);
    writeFileSync(join(f.root, 'file.txt'), 'working');
    writeFileSync(join(f.root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(f.root, 'ignored.txt'), 'ignored');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const staged = await f.client.command('readComparison', {
        target: { checkout, path: 'file.txt' },
        area: 'staged',
      }),
      unstaged = await f.client.command('readComparison', {
        target: { checkout, path: 'file.txt' },
        area: 'unstaged',
      });
    assert.equal(staged.original, 'HEAD');
    assert.equal(unstaged.original, 'index');
    assert.equal(staged.working?.text, 'working');
    assert.deepEqual(
      (await f.client.command('gitStatus', { checkout })).changes
        .filter((c) => c.path === 'file.txt')
        .map((c) => c.area),
      ['staged', 'unstaged'],
    );
    assert(
      (await f.client.command('lookupFiles', { checkout, query: 'fltx' })).matches.some(
        (match) => match.path === 'file.txt',
      ),
    );
    assert(
      !(
        await f.client.command('listDirectory', { checkout, path: '', hideIgnored: true })
      ).entries.some((e) => e.path === 'ignored.txt'),
    );
    rmSync(join(f.root, 'file.txt'));
    const deleted = await f.client.command('readComparison', {
      target: { checkout, path: 'file.txt' },
      area: 'unstaged',
    });
    assert.equal(deleted.original, 'index');
    assert.equal(deleted.working, null);
  } finally {
    await f.close();
  }
});

test('watch notifies external changes, coalesces and disposes independently of file commands', async () => {
  const f = fixture();
  let stop = async () => {};
  try {
    writeFileSync(join(f.root, 'file.txt'), 'before');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    let ready!: () => void,
      changed!: () => void,
      count = 0;
    const readyPromise = new Promise<void>((r) => (ready = r)),
      changedPromise = new Promise<void>((r) => (changed = r));
    stop = f.client.watch(
      { checkout, paths: [''] },
      (event) => {
        count++;
        if (event.ready) ready();
        else changed();
      },
      (error) => {
        throw error;
      },
    );
    await readyPromise;
    writeFileSync(join(f.root, 'file.txt'), 'external');
    await Promise.race([
      changedPromise,
      new Promise((_, reject) => setTimeout(() => reject(Error('watch timeout')), 2000)),
    ]);
    await stop();
    await f.runtime.runPromise(Effect.yieldNow);
    const before = count;
    writeFileSync(join(f.root, 'file.txt'), 'after disposal');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(count, before);
    assert.equal(
      (await f.client.command('readFile', { checkout, path: 'file.txt' })).text,
      'after disposal',
    );
  } finally {
    await stop();
    await f.close();
  }
});

test('watch skips activity that belongs to other worktrees of the repository', async () => {
  const f = fixture();
  const stops: (() => Promise<void>)[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  const settle = () => new Promise((r) => setTimeout(r, 400));
  try {
    writeFileSync(join(f.root, 'file.txt'), 'main');
    writeFileSync(join(f.root, '.gitignore'), '.agents/\n');
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', 'initial');
    // An agent's worktree inside an ignored folder of the main checkout, plus one beside it.
    const nested = join(f.root, '.agents', 'nested'),
      beside = join(f.base, 'beside');
    git(f.root, 'worktree', 'add', '-q', '-b', 'nested', nested);
    git(f.root, 'worktree', 'add', '-q', '-b', 'beside', beside);
    const watchEvents = async (root: string) => {
      const checkout = await f.client.command('openCheckout', { root });
      const events: string[] = [];
      let ready!: () => void;
      const isReady = new Promise<void>((r) => (ready = r));
      stops.push(
        f.client.watch(
          { checkout, paths: [''] },
          (event) => (event.ready ? ready() : events.push(event.error ?? 'changed')),
          (error) => {
            throw error;
          },
        ),
      );
      await isReady;
      return events;
    };
    const main = await watchEvents(f.root),
      linked = await watchEvents(beside);
    await settle();
    main.length = linked.length = 0;

    // Files and Git activity in the nested worktree reach neither of the other checkouts.
    writeFileSync(join(nested, 'file.txt'), 'agent edit');
    writeFileSync(join(nested, 'new.txt'), 'agent file');
    git(nested, 'add', '.');
    git(nested, 'status', '--short');
    await settle();
    assert.deepEqual(main, [], 'A nested worktree must not refresh the main checkout');
    // Staging in the main checkout refreshes it, but not the linked worktree.
    writeFileSync(join(f.root, 'staged.txt'), 'staged');
    git(f.root, 'add', 'staged.txt');
    await settle();
    assert(main.length > 0);
    assert.deepEqual(linked, [], "Other worktrees' files and indexes must not refresh it");

    // Their own files still refresh them.
    main.length = 0;
    writeFileSync(join(beside, 'file.txt'), 'own edit');
    writeFileSync(join(f.root, 'file.txt'), 'own edit');
    await settle();
    assert.equal(linked.length, 1);
    assert.equal(main.length, 1);
    // Another worktree's commit moves a shared branch ref, which both still see.
    main.length = linked.length = 0;
    git(nested, 'commit', '-qm', 'agent commit');
    await settle();
    assert(main.length > 0 && linked.length > 0, 'A new commit moves a shared ref');
  } finally {
    for (const stop of stops) await stop();
    await f.close();
  }
});

test('text search honours ignore policies, options, context lines and UTF-16 ranges', async () => {
  const f = fixture();
  try {
    for (const p of ['src', 'node_modules']) mkdirSync(join(f.root, p));
    writeFileSync(
      join(f.root, 'src/view.ts'),
      'one\ntwo\nconst é = followEnd(); // followEnd\nfour\nfive\nsix\nFollowEnd\n',
    );
    writeFileSync(join(f.root, 'src/followEnder.ts'), 'followEnder\n');
    writeFileSync(join(f.root, 'node_modules/dep.ts'), 'followEnd\n');
    writeFileSync(join(f.root, 'ignored.ts'), 'followEnd\n');
    writeFileSync(join(f.root, '.gitignore'), 'ignored.ts\n');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const search = (
      query: string,
      options: Partial<Record<'matchCase' | 'wholeWord' | 'regex', boolean>> = {},
    ) =>
      f.client.command('searchText', {
        checkout,
        query,
        matchCase: false,
        wholeWord: false,
        regex: false,
        ...options,
      });
    const all = await search('followEnd');
    assert(!all.partial, all.error ?? 'Unexpected partial search');
    assert.deepEqual(
      all.files.map((file) => [file.path, file.matches.map((match) => match.line)]),
      [
        ['src/followEnder.ts', [1]],
        ['src/view.ts', [3, 7]],
      ],
    );
    const [line] = all.files[1].matches;
    assert.equal(line.text, 'const é = followEnd(); // followEnd');
    assert.deepEqual(
      line.ranges.map((range) => line.text.slice(range.start, range.end)),
      ['followEnd', 'followEnd'],
    );
    assert.deepEqual(line.before, ['one', 'two']);
    assert.deepEqual(line.after, ['four', 'five', 'six']);
    assert.deepEqual(
      (await search('followEnd', { matchCase: true })).files[1].matches.map((m) => m.line),
      [3],
    );
    assert.deepEqual(
      (await search('followEnd', { wholeWord: true })).files.map((file) => file.path),
      ['src/view.ts'],
    );
    assert.equal((await search('follow.nd(')).files.length, 0);
    assert.equal((await search('follow.nd\\(', { regex: true })).files[0].path, 'src/view.ts');
    await assert.rejects(search('(', { regex: true }), rejects('InvalidInput'));
    // ripgrep's reason is shown, not its trailing hint, and every pattern refusal is invalid input.
    await assert.rejects(
      search('(?<=x)y', { regex: true }),
      (error) =>
        rejects('InvalidInput')(error) &&
        /^Invalid regular expression: look-around.* is not supported$/.test(
          (error as Error).message,
        ),
    );
    await assert.rejects(
      search('a\\nb', { regex: true }),
      (error) =>
        rejects('InvalidInput')(error) &&
        (error as Error).message ===
          'Invalid regular expression: the literal "\\n" is not allowed in a regex',
    );
    // Past 50 matches a file is capped and reported partial, whether its matches are adjacent
    // (ripgrep keeps reporting matches inside trailing context) or spread out.
    writeFileSync(join(f.root, 'src/many.ts'), 'manyMatch\n'.repeat(60));
    writeFileSync(join(f.root, 'src/spread.ts'), 'spreadMatch\nx\nx\nx\nx\n'.repeat(60));
    for (const query of ['manyMatch', 'spreadMatch']) {
      const many = await search(query);
      assert.equal(many.partial, true, query);
      assert.equal(many.files[0].matches.length, 50, query);
    }
    // A query that looks like a flag is still the pattern.
    writeFileSync(join(f.root, 'src/flags.ts'), 'run --files here\n');
    assert.deepEqual(
      (await search('--files')).files.map((file) => file.path),
      ['src/flags.ts'],
    );
    // An unreadable file is reported without marking the other results partial.
    writeFileSync(join(f.root, 'src/locked.ts'), 'followEnd\n');
    chmodSync(join(f.root, 'src/locked.ts'), 0);
    try {
      const locked = await search('followEnd');
      assert.equal(locked.partial, false);
      assert.match(locked.error ?? '', /Some files could not be searched/);
      assert.deepEqual(
        locked.files.map((file) => file.path),
        ['src/followEnder.ts', 'src/view.ts'],
      );
    } finally {
      chmodSync(join(f.root, 'src/locked.ts'), 0o644);
    }
  } finally {
    await f.close();
  }
});

test('a broad text search stops at the cap with a clean partial result', async () => {
  const f = fixture();
  try {
    // Far more than 16 MiB of ripgrep output if every file were searched to its own cap.
    const line = 'e'.repeat(1500) + '\n';
    for (let n = 0; n < 60; n++)
      writeFileSync(join(f.root, `file-${String(n).padStart(2, '0')}.txt`), line.repeat(60));
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const result = await f.client.command('searchText', {
      checkout,
      query: 'e',
      matchCase: false,
      wholeWord: false,
      regex: false,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.partial, true);
    assert.equal(
      result.files.reduce((total, file) => total + file.matches.length, 0),
      500,
    );
    assert.deepEqual(
      result.files.map((file) => file.path),
      Array.from({ length: 10 }, (_, n) => `file-${String(n).padStart(2, '0')}.txt`),
    );
    // The last match kept still has its trailing context.
    assert.equal(result.files.at(-1)!.matches.at(-1)!.after.length, 3);
  } finally {
    await f.close();
  }
});

test('lookup honors nested ignore policies, ranks and highlights all pieces, quotes contiguous text, and keeps history separate', async () => {
  const f = fixture();
  try {
    for (const p of ['src', 'nested', 'node_modules']) mkdirSync(join(f.root, p));
    const files = [
      'src/FooBar.test.ts',
      'src/foo-baz.ts',
      'nested/hidden.ts',
      'nested/keep.ts',
      'node_modules/dep.ts',
      'ignored.ts',
      'rg-hidden.ts',
    ];
    files.forEach((p) => writeFileSync(join(f.root, p), p));
    writeFileSync(join(f.root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(f.root, '.ignore'), 'rg-hidden.ts\n');
    writeFileSync(join(f.root, 'nested/.rgignore'), 'hidden.ts\n');
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const all = await f.client.command('lookupFiles', { checkout, query: 'ts' });
    assert(!all.partial, all.error ?? 'Unexpected partial discovery');
    assert(all.matches.some((m) => m.path === 'nested/keep.ts'));
    for (const hidden of ['nested/hidden.ts', 'node_modules/dep.ts', 'ignored.ts', 'rg-hidden.ts'])
      assert(!all.matches.some((m) => m.path === hidden));
    const pieces = await f.client.command('lookupFiles', { checkout, query: 'FB ts' });
    assert.equal(pieces.matches[0].path, 'src/FooBar.test.ts');
    assert.deepEqual(
      pieces.matches[0].positions.map((p) => pieces.matches[0].path[p]).join(''),
      'FBts',
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: 'FB nonexistent' })).matches.length,
      0,
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '"FooBar"' })).matches[0].path,
      'src/FooBar.test.ts',
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '"FB"' })).matches.length,
      0,
    );
    const history = [
      'node_modules/dep.ts',
      'missing.ts',
      'node_modules/dep.ts',
      'src/FooBar.test.ts',
    ];
    const recent = await f.client.command('lookupFiles', { checkout, query: 'ts', history });
    assert.equal(recent.history.filter((m) => m.path === 'node_modules/dep.ts').length, 1);
    assert(recent.history.some((m) => m.path === 'missing.ts'));
    assert(!recent.matches.some((m) => history.includes(m.path)));
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: '', history })).matches.length,
      0,
    );
    assert.equal(
      (await f.client.command('lookupFiles', { checkout, query: 'node_modules/dep.ts' })).matches[0]
        .path,
      'node_modules/dep.ts',
    );
    assert((await f.client.command('lookupFiles', { checkout, query: 'ts', limit: 1 })).partial);
    await assert.rejects(
      f.client.command('lookupFiles', { checkout, query: 'ts', history: ['../outside'] }),
      rejects('InvalidInput'),
    );
    writeFileSync(join(f.base, 'outside-ignore'), '*\n');
    rmSync(join(f.root, '.ignore'));
    symlinkSync(join(f.base, 'outside-ignore'), join(f.root, '.ignore'));
    const unavailable = await f.client.command('lookupFiles', { checkout, query: 'ts' });
    assert(unavailable.partial && unavailable.error);
    assert.equal(unavailable.matches.length, 0);
  } finally {
    await f.close();
  }
});

test('unsubscribe during pending workspace/watch acquisition and concurrent runtime disposal release all native watchers', async () => {
  const f = fixture();
  try {
    const checkout = await f.client.command('openCheckout', { root: f.root });
    const before = process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;
    let delivered = 0;
    const errors: unknown[] = [];
    const stops = Array.from({ length: 16 }, () =>
      f.client.watch(
        { checkout, paths: [''] },
        () => delivered++,
        (error) => errors.push(error),
      ),
    );
    await Promise.all(stops.map((stop) => stop()));
    await f.runtime.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(delivered, 0);
    assert.equal(errors.length, 0);
    assert.equal(
      process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length,
      before,
    );
  } finally {
    await f.close();
  }
});

test('native assets in packaged resource paths run with restricted PATH and no provider startup dependency', async () => {
  const { fileURLToPath } = await import('node:url'),
    { copyFileSync } = await import('node:fs');
  const f = fixture();
  try {
    const resources = join(f.base, 'Packaged Resources');
    mkdirSync(resources);
    const filesystem = join(resources, 'filesystem'),
      rg = join(resources, 'ripgrep');
    copyFileSync(fileURLToPath(new URL('../dist/filesystem', import.meta.url)), filesystem);
    chmodSync(filesystem, 0o700);
    const installed =
      process.env.MOONBASE_TEST_RIPGREP ??
      execFileSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim();
    copyFileSync(installed, rg);
    chmodSync(rg, 0o700);
    writeFileSync(join(f.root, 'file.txt'), 'disk');
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./packaged-assets.fixture.ts', import.meta.url)),
        f.root,
        f.dataDirectory,
        filesystem,
        rg,
      ],
      { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 },
    );
    assert(output.includes('Independent workspace assets passed'));
    assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'saved from isolated assets');
  } finally {
    await f.close();
  }
});
