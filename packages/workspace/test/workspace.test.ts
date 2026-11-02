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
