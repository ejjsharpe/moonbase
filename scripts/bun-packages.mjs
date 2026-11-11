import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// The third-party packages built into the Bun runtime the daemon ships on, and their licence
// texts. Bun's `bun-v1.4.4` tag pins them in two lockfiles: `Cargo.lock` for the Rust crates it is
// built from, and `src/node-fallbacks/bun.lock` for the npm packages of the Node.js polyfills it
// embeds. Every registry package of both is included, whether or not this build links it.
// `bun-packages.json` records each package's licence files and their SHA-256, so preparing the
// runtime downloads each package's official archive, verifies it against its lockfile checksum
// and keeps only those exact licence texts. Run this file to regenerate that manifest.

const bunCommit = '38afee6c84fcf48c0edb2466aa4b27d287a59c30';
const raw = (path) => `https://raw.githubusercontent.com/oven-sh/bun/${bunCommit}/${path}`;
export const packageLocks = {
  crates: {
    url: raw('Cargo.lock'),
    sha256: 'e50fc1503af23002906856add618fb9b921a94573c9905d6b2d06a7851096860',
  },
  npm: {
    url: raw('src/node-fallbacks/bun.lock'),
    sha256: 'f2694f1fbc8689075bf005d90cecaeb393967cf96b735a8315198144278ea11d',
  },
};
const manifestUrl = new URL('./bun-packages.json', import.meta.url);
/** The committed manifest: `{packages: [{ecosystem, name, version, checksum|integrity, license, files: [{path, sha256}]}]}`. */
export const bunPackages = JSON.parse(await readFile(manifestUrl, 'utf8')).packages;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reads a response with a running cap, so an oversized body stops downloading at the cap. */
export async function download(fetch, url, maxBytes, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `${label} download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    // Leaving the loop cancels the rest of the body.
    assert(size <= maxBytes, `Unexpected ${label} size`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const cratesRegistry = 'registry+https://github.com/rust-lang/crates.io-index';
/** The crates.io packages of a `Cargo.lock`, with the SHA-256 Cargo records for each archive. */
export function parseCargoLock(text) {
  const packages = [];
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
    if (field('source') === undefined) continue;
    assert.equal(field('source'), cratesRegistry, `Unexpected crate source for ${field('name')}`);
    const name = field('name'),
      version = field('version'),
      checksum = field('checksum');
    assert(/^[\w-]+$/.test(name) && /^[\w.+-]+$/.test(version), `Unexpected crate ${name}`);
    assert.match(checksum, /^[0-9a-f]{64}$/, `Unexpected checksum for ${name}`);
    packages.push({ ecosystem: 'crates', name, version, checksum });
  }
  return packages;
}

/** The npm registry packages of a `bun.lock`, with the SHA-512 integrity it records for each. */
export function parseBunLock(text) {
  // bun.lock is JSON with trailing commas.
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  const packages = new Map();
  for (const [ident, registry, , integrity] of Object.values(lock.packages)) {
    assert.equal(registry, '', `Unexpected npm source for ${ident}`);
    const at = ident.lastIndexOf('@'),
      name = ident.slice(0, at),
      version = ident.slice(at + 1);
    assert(/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) && /^[\w.+-]+$/.test(version), ident);
    assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `Unexpected integrity for ${ident}`);
    packages.set(ident, { ecosystem: 'npm', name, version, integrity });
  }
  return [...packages.values()];
}

const identity = ({ ecosystem, name, version, checksum, integrity }) =>
  ecosystem === 'crates'
    ? { ecosystem, name, version, checksum }
    : { ecosystem, name, version, integrity };
// Code-point order, the same on every machine.
const compare = (a, b) => Number(a > b) - Number(a < b);
const order = (a, b) =>
  compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name) || compare(a.version, b.version);

/** The package's official registry archive. */
export function packageArchiveUrl({ ecosystem, name, version }) {
  if (ecosystem === 'crates')
    return `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  return `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}

/** Refuses an archive whose digest differs from the one its lockfile records. */
export function verifyPackageArchive(pkg, bytes) {
  const label = `${pkg.name}@${pkg.version}`;
  if (pkg.ecosystem === 'crates')
    assert.equal(sha256(bytes), pkg.checksum, `Bun package checksum mismatch: ${label}`);
  else
    assert.equal(
      'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      pkg.integrity,
      `Bun package checksum mismatch: ${label}`,
    );
}

/** The regular files of a tar archive, as `[path, bytes]`, following GNU and pax long names. */
export function readTar(bytes) {
  const files = [];
  let offset = 0,
    longName;
  const text = (start, length) =>
    bytes
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assert((header[124] & 0x80) === 0, 'Unexpected tar entry size');
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8),
      type = String.fromCharCode(header[156] || 48),
      start = offset + 512,
      body = bytes.subarray(start, start + size);
    assert(Number.isSafeInteger(size) && start + size <= bytes.length, 'Truncated tar archive');
    let name = text(offset, 100);
    if (text(offset + 257, 5) === 'ustar' && text(offset + 345, 155))
      name = text(offset + 345, 155) + '/' + name;
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x')
      longName = body.toString('utf8').match(/^\d+ path=(.*)$/m)?.[1] ?? longName;
    else if (type === 'g') continue;
    else {
      if (type === '0') files.push([longName ?? name, Buffer.from(body)]);
      longName = undefined;
    }
  }
  return files;
}

const licenceName = /^(?:licen[sc]e|copying|copyright|notice|unlicense|patents)/i;
/**
 * The licence a package declares and the licence files at the top of its archive (plus a crate's
 * `license-file`, or the README when there are none), never anything else from it.
 */
export function readLicenceFiles(pkg, archive) {
  const entries = readTar(gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }));
  // A crate's files are under `name-version/`; an npm package's under one folder, usually `package/`.
  const folders = new Map();
  for (const [path] of entries)
    if (path.includes('/'))
      folders.set(path.split('/')[0], (folders.get(path.split('/')[0]) ?? 0) + 1);
  const root =
    pkg.ecosystem === 'crates'
      ? `${pkg.name}-${pkg.version}`
      : [...folders].sort(([, a], [, b]) => b - a)[0]?.[0];
  assert(root && folders.has(root), `Unexpected package archive: ${pkg.name}@${pkg.version}`);
  const byPath = new Map();
  for (const [path, bytes] of entries) {
    const normal = posix.normalize(path);
    if (normal.startsWith(root + '/') && !normal.split('/').includes('..'))
      byPath.set(normal.slice(root.length + 1), bytes);
  }
  let license, licenseFile;
  if (pkg.ecosystem === 'crates') {
    const manifest = byPath.get('Cargo.toml')?.toString('utf8') ?? '';
    const section = manifest.split(/^(?=\[)/m).find((part) => part.startsWith('[package]\n')) ?? '';
    license = section.match(/^license\s*=\s*"([^"]*)"/m)?.[1];
    licenseFile = section.match(/^license-file\s*=\s*"([^"]*)"/m)?.[1];
  } else {
    const manifest = JSON.parse(byPath.get('package.json')?.toString('utf8') ?? '{}');
    const declared = manifest.license ?? manifest.licenses;
    license = Array.isArray(declared)
      ? declared.map((entry) => entry.type ?? entry).join(' OR ')
      : (declared?.type ?? declared);
  }
  const files = [];
  for (const [path, bytes] of [...byPath].sort(([a], [b]) => compare(a, b)))
    if ((!path.includes('/') && licenceName.test(path)) || path === licenseFile) {
      assert(bytes.length <= 1024 * 1024, `Unexpected licence size: ${pkg.name} ${path}`);
      files.push({ path, bytes });
    }
  // With no licence file, the top-level README, where such packages state their licence.
  if (!files.length)
    for (const [path, bytes] of byPath)
      if (!path.includes('/') && /^readme/i.test(path) && bytes.length <= 1024 * 1024)
        files.push({ path, bytes });
  const folded = new Set(files.map(({ path }) => path.toLowerCase()));
  assert.equal(folded.size, files.length, `Licence names collide: ${pkg.name}@${pkg.version}`);
  return { license: license ?? null, files };
}

/** Where a package's licence file goes in the prepared runtime folder. */
export const packageNoticeFile = ({ ecosystem, name, version }, path) =>
  `notices/${ecosystem}/${name.replace('/', '+')}@${version}/${path.replaceAll('/', '+')}`;

async function mapLimited(items, limit, map) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await map(items[index]);
      }
    }),
  );
  return results;
}

/**
 * Downloads both pinned lockfiles and every package archive they name, verifying each before
 * reading it, and returns each package with its licence and licence files. With `packages` (the
 * manifest), the lockfiles must name exactly those packages and every licence file must be the
 * recorded bytes; any difference fails.
 */
export async function collectPackageNotices({
  fetch = globalThis.fetch,
  locks = packageLocks,
  packages,
  concurrency = 8,
} = {}) {
  const locked = [];
  for (const [ecosystem, lock] of Object.entries(locks)) {
    const bytes = await download(fetch, lock.url, 4 * 1024 * 1024, `${ecosystem} lockfile`);
    assert.equal(sha256(bytes), lock.sha256, `Bun lockfile checksum mismatch: ${ecosystem}`);
    const text = bytes.toString('utf8');
    locked.push(...(ecosystem === 'crates' ? parseCargoLock(text) : parseBunLock(text)));
  }
  locked.sort(order);
  if (packages)
    assert.deepEqual(
      locked,
      packages.map(identity).sort(order),
      'Bun package manifest differs from its lockfiles',
    );
  const recorded = new Map(
    packages?.map((pkg) => [`${pkg.ecosystem}:${pkg.name}@${pkg.version}`, pkg]),
  );
  return mapLimited(locked, concurrency, async (pkg) => {
    const label = `${pkg.name}@${pkg.version}`;
    const archive = await download(fetch, packageArchiveUrl(pkg), 32 * 1024 * 1024, label);
    verifyPackageArchive(pkg, archive);
    const { license, files } = readLicenceFiles(pkg, archive);
    const collected = {
      ...pkg,
      license,
      files: files.map(({ path, bytes }) => ({ path, sha256: sha256(bytes), bytes })),
    };
    const expected = recorded.get(`${pkg.ecosystem}:${label}`);
    if (expected)
      assert.deepEqual(
        collected.files.map(({ path, sha256 }) => ({ path, sha256 })),
        expected.files,
        `Bun package notice mismatch: ${label}`,
      );
    return collected;
  });
}

/** Writes collected licence files into a runtime folder at their `packageNoticeFile` paths. */
export async function writePackageNotices(directory, collected) {
  for (const pkg of collected)
    for (const { path, bytes } of pkg.files) {
      const file = join(directory, packageNoticeFile(pkg, path));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const collected = await collectPackageNotices();
  const packages = collected.map(({ files, license, ...pkg }) => ({
    ...pkg,
    license,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  }));
  await writeFile(manifestUrl, JSON.stringify({ packages }, null, 2) + '\n');
  const readmes = packages.filter((pkg) => pkg.files.every(({ path }) => /^readme/i.test(path)));
  console.log(`Recorded ${packages.length} Bun packages (${readmes.length} with only a README).`);
}
