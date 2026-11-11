import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bunPackages,
  collectPackageNotices,
  packageArchiveUrl,
  packageLocks,
  packageNoticeFile,
  writePackageNotices,
} from './bun-packages.mjs';
import { bunComponents } from './prepare-bun.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

/** A gzipped tar of `files` (path to contents, or `{link}` for a symlink) under `root`. */
async function makeTarball(t, root, files) {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-bun-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    const file = join(directory, root, path);
    await mkdir(join(file, '..'), { recursive: true });
    if (typeof contents === 'string') await writeFile(file, contents);
    else await symlink(contents.link, file);
  }
  execFileSync('/usr/bin/tar', ['-czf', 'package.tgz', root], {
    cwd: directory,
    // No AppleDouble entries, as a registry archive has none.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return readFile(join(directory, 'package.tgz'));
}

const longFolder = 'a'.repeat(60) + '/' + 'b'.repeat(60);
/** One crate and one npm package, their lockfiles and the fetch that serves them. */
async function makeRegistry(t) {
  const crate = await makeTarball(t, 'demo-1.2.3', {
    'Cargo.toml':
      '[package]\nname = "demo"\nlicense = "MIT OR Apache-2.0"\nlicense-file = "legal/TERMS"\n\n[dependencies]\nlicense = "not this"\n',
    'LICENSE-MIT': 'MIT text',
    'LICENSE-APACHE': 'Apache text',
    'legal/TERMS': 'Terms text',
    'src/LICENSE': 'nested, not a package licence',
    [`${longFolder}/NOTICE`]: 'nested under a long name',
    COPYING: { link: '/etc/passwd' },
    'README.md': 'not needed beside a licence',
    'build.rs': 'fn main() {}',
  });
  const npm = await makeTarball(t, 'package', {
    'package.json': JSON.stringify({ name: '@scope/poly', version: '4.5.6', license: 'ISC' }),
    'README.md': '# poly\n\nISC licensed.',
    'index.js': 'module.exports = 1;',
  });
  const cargoLock = Buffer.from(
    `version = 4\n\n[[package]]\nname = "bun_core"\nversion = "1.4.4"\n\n[[package]]\nname = "demo"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${sha256(crate)}"\n`,
  );
  const bunLock = Buffer.from(
    `{\n  "lockfileVersion": 1,\n  "packages": {\n    "@scope/poly": ["@scope/poly@4.5.6", "", {}, "${sha512(npm)}"],\n  },\n}\n`,
  );
  const locks = {
    crates: { url: 'https://locks.test/Cargo.lock', sha256: sha256(cargoLock) },
    npm: { url: 'https://locks.test/bun.lock', sha256: sha256(bunLock) },
  };
  const served = new Map([
    [locks.crates.url, cargoLock],
    [locks.npm.url, bunLock],
    ['https://static.crates.io/crates/demo/demo-1.2.3.crate', crate],
    ['https://registry.npmjs.org/@scope/poly/-/poly-4.5.6.tgz', npm],
  ]);
  const requested = [];
  const fetch = async (url, options) => {
    requested.push(url);
    assert(options.signal instanceof AbortSignal);
    return served.has(url) ? new Response(served.get(url)) : new Response('', { status: 404 });
  };
  return { crate, npm, locks, served, requested, fetch };
}

const manifestOf = (collected) =>
  collected.map(({ files, ...pkg }) => ({
    ...pkg,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  }));

test('only the licence files of verified official archives are kept', async (t) => {
  const registry = await makeRegistry(t);
  const collected = await collectPackageNotices({ fetch: registry.fetch, locks: registry.locks });
  // Path dependencies are Bun's own; only registry packages are fetched, from their registries.
  assert.deepEqual(registry.requested.slice(2).sort(), [
    'https://registry.npmjs.org/@scope/poly/-/poly-4.5.6.tgz',
    'https://static.crates.io/crates/demo/demo-1.2.3.crate',
  ]);
  const [crate, npm] = collected;
  assert.equal(crate.license, 'MIT OR Apache-2.0');
  assert.deepEqual(
    crate.files.map(({ path, bytes }) => [path, bytes.toString()]),
    [
      ['LICENSE-APACHE', 'Apache text'],
      ['LICENSE-MIT', 'MIT text'],
      ['legal/TERMS', 'Terms text'],
    ],
  );
  // With no licence file, the README stands in.
  assert.equal(npm.license, 'ISC');
  assert.deepEqual(
    npm.files.map(({ path }) => path),
    ['README.md'],
  );
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-bun-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writePackageNotices(directory, collected);
  assert.equal(
    await readFile(join(directory, packageNoticeFile(crate, 'legal/TERMS')), 'utf8'),
    'Terms text',
  );
  assert.equal(packageNoticeFile(npm, 'README.md'), 'notices/npm/@scope+poly@4.5.6/README.md');
  // Checked against a manifest of exactly what it found, it passes again.
  await collectPackageNotices({
    fetch: registry.fetch,
    locks: registry.locks,
    packages: manifestOf(collected),
  });
});

test('a tampered lockfile, package archive or licence text, or a stale manifest, is refused', async (t) => {
  const registry = await makeRegistry(t);
  const manifest = manifestOf(
    await collectPackageNotices({ fetch: registry.fetch, locks: registry.locks }),
  );
  const run = (packages = manifest) =>
    collectPackageNotices({ fetch: registry.fetch, locks: registry.locks, packages });

  registry.requested.length = 0;
  registry.served.set(registry.locks.crates.url, Buffer.from('tampered'));
  await assert.rejects(run(), /Bun lockfile checksum mismatch: crates/);
  assert.deepEqual(registry.requested, [registry.locks.crates.url]);

  const fresh = await makeRegistry(t);
  const freshManifest = manifestOf(
    await collectPackageNotices({ fetch: fresh.fetch, locks: fresh.locks }),
  );
  const freshRun = (packages = freshManifest) =>
    collectPackageNotices({ fetch: fresh.fetch, locks: fresh.locks, packages });

  // A manifest naming other packages than the lockfiles fails before any archive downloads.
  fresh.requested.length = 0;
  await assert.rejects(
    freshRun(freshManifest.map((pkg) => ({ ...pkg, version: pkg.version + '1' }))),
    /Bun package manifest differs from its lockfiles/,
  );
  assert.deepEqual(fresh.requested, [fresh.locks.crates.url, fresh.locks.npm.url]);

  // A licence text other than the recorded one.
  await assert.rejects(
    freshRun(
      freshManifest.map((pkg) => ({
        ...pkg,
        files: pkg.files.map((file) => ({ ...file, sha256: sha256('other') })),
      })),
    ),
    /Bun package notice mismatch/,
  );

  // An archive other than the locked one, for either registry.
  for (const url of [
    'https://static.crates.io/crates/demo/demo-1.2.3.crate',
    'https://registry.npmjs.org/@scope/poly/-/poly-4.5.6.tgz',
  ]) {
    const original = fresh.served.get(url);
    fresh.served.set(url, Buffer.concat([original, Buffer.from([0])]));
    await assert.rejects(freshRun(), /Bun package checksum mismatch/);
    fresh.served.set(url, original);
  }
  await freshRun();
});

test('the committed manifest covers every locked package with official archives and pinned texts', () => {
  assert.match(
    packageLocks.crates.url,
    /^https:\/\/raw\.githubusercontent\.com\/oven-sh\/bun\/[0-9a-f]{40}\/Cargo\.lock$/,
  );
  assert.match(
    packageLocks.npm.url,
    /^https:\/\/raw\.githubusercontent\.com\/oven-sh\/bun\/[0-9a-f]{40}\/src\/node-fallbacks\/bun\.lock$/,
  );
  assert(bunPackages.filter((pkg) => pkg.ecosystem === 'crates').length >= 180);
  assert(bunPackages.filter((pkg) => pkg.ecosystem === 'npm').length >= 100);
  const files = new Set();
  for (const pkg of bunPackages) {
    assert.match(
      packageArchiveUrl(pkg),
      /^https:\/\/(?:static\.crates\.io\/crates\/|registry\.npmjs\.org\/)/,
    );
    assert(pkg.license, `${pkg.name} declares no licence`);
    assert(pkg.files.length, `${pkg.name} has no notice`);
    for (const { path, sha256 } of pkg.files) {
      assert.match(sha256, /^[0-9a-f]{64}$/);
      const file = packageNoticeFile(pkg, path).toLowerCase();
      assert(!files.has(file), `Two notices share ${file}`);
      files.add(file);
    }
    assert(
      bunComponents.some((component) => component.label.startsWith(`${pkg.name} ${pkg.version}, `)),
      `No notice component for ${pkg.name}`,
    );
  }
});
