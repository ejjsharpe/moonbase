import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bunExecutableSha256,
  bunNotices,
  bunVersion,
  prepareBun,
  verifyBunRuntime,
} from './prepare-bun.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const releaseUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip`;

/** A temporary folder with an isolated download root and a previous runtime to keep. */
async function prepareFolders(t) {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-prepare-bun-')),
    output = join(directory, 'tools', 'bun'),
    temporaryDirectory = join(directory, 'temporary');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  await mkdir(temporaryDirectory);
  await writeFile(join(output, 'bun'), 'previous runtime');
  return { directory, output, temporaryDirectory };
}

/** Asserts the failed run kept the previous runtime and left no download cache behind. */
async function assertUntouched({ directory, output, temporaryDirectory }) {
  assert.equal(await readFile(join(output, 'bun'), 'utf8'), 'previous runtime');
  assert.deepEqual(await readdir(join(directory, 'tools')), ['bun']);
  assert.deepEqual(await readdir(temporaryDirectory), [], 'A download cache outlived the build');
}

/** A zip of `files` (relative path to contents), and an asset pinned to its checksums. */
async function makeArchive(t, files, executable = files['bun-darwin-aarch64/bun'] ?? '') {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-bun-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  // Like the release: the folder's own entry first, then its files.
  execFileSync('/usr/bin/zip', ['-qr', 'archive.zip', 'bun-darwin-aarch64'], { cwd: directory });
  const archive = await readFile(join(directory, 'archive.zip'));
  return {
    archive,
    asset: {
      name: 'bun-darwin-aarch64',
      sha256: sha256(archive),
      executableSha256: sha256(executable),
    },
  };
}

test('a Bun download that fails its pinned checksum or request fails the build and keeps the previous runtime', async (t) => {
  const folders = await prepareFolders(t);
  const requested = [];
  let response = () => new Response('a tampered archive');
  const fetch = async (url, options) => {
    requested.push(url);
    assert(options.signal instanceof AbortSignal);
    return response();
  };
  for (const [reply, error] of [
    [() => new Response('a tampered archive'), /Bun release checksum mismatch/],
    [() => new Response('', { status: 503 }), /Bun download failed: HTTP 503/],
  ]) {
    response = reply;
    await assert.rejects(
      prepareBun({
        output: folders.output,
        temporaryDirectory: folders.temporaryDirectory,
        arch: 'arm64',
        platform: 'darwin',
        fetch,
      }),
      (rejected) => error.test(rejected.message),
    );
  }
  // Only the pinned official release was requested, and nothing past the failed archive.
  assert.deepEqual(requested, [releaseUrl, releaseUrl]);
  await assertUntouched(folders);
});

test('an archive with another layout, another executable or a tampered notice fails before Bun runs', async (t) => {
  const folders = await prepareFolders(t);
  // A `bun` that would leave a mark if it ever ran.
  const marker = join(folders.directory, 'ran');
  const script = `#!/bin/sh\ntouch ${marker}\necho ${bunVersion}\n`;
  const extra = await makeArchive(t, {
    'bun-darwin-aarch64/bun': script,
    'bun-darwin-aarch64/extra': 'unexpected',
  });
  const other = await makeArchive(t, { 'bun-darwin-aarch64/bun': script }, 'the pinned bytes');
  const pinned = await makeArchive(t, { 'bun-darwin-aarch64/bun': script });
  for (const [{ archive, asset }, notice, error] of [
    [extra, undefined, /Unexpected Bun archive/],
    [other, undefined, /Bun executable checksum mismatch/],
    [pinned, () => new Response('a tampered notice'), /Bun notice checksum mismatch: LICENSE\.md/],
  ]) {
    const requested = [];
    const fetch = async (url) => {
      requested.push(url);
      if (url === releaseUrl) return new Response(archive);
      return notice ? notice() : assert.fail('No notice download for a refused archive');
    };
    await assert.rejects(
      prepareBun({
        output: folders.output,
        temporaryDirectory: folders.temporaryDirectory,
        arch: 'arm64',
        platform: 'darwin',
        fetch,
        asset,
      }),
      (rejected) => error.test(rejected.message),
    );
    assert.deepEqual(requested, notice ? [releaseUrl, bunNotices[0].url] : [releaseUrl]);
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assertUntouched(folders);
});

test('an oversized download stops reading at its cap', async (t) => {
  const folders = await prepareFolders(t);
  const { archive, asset } = await makeArchive(t, { 'bun-darwin-aarch64/bun': 'bun' });
  let pulled = 0,
    cancelled = false;
  // An endless notice: reading it whole would never finish.
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const fetch = async (url) => (url === releaseUrl ? new Response(archive) : endless());
  await assert.rejects(
    prepareBun({
      output: folders.output,
      temporaryDirectory: folders.temporaryDirectory,
      arch: 'arm64',
      platform: 'darwin',
      fetch,
      asset,
    }),
    /Unexpected LICENSE\.md size/,
  );
  assert(cancelled, 'The oversized body was not cancelled');
  assert(pulled <= 1024 / 64 + 2, `Read ${pulled} chunks past a 1 MiB cap`);
  await assertUntouched(folders);
});

test('a prepared runtime whose executable or notices differ from the pinned bytes is refused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-bun-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'notices'));
  await writeFile(join(directory, 'bun'), 'a substituted runtime');
  await assert.rejects(verifyBunRuntime(directory), /Bun executable checksum mismatch/);
  assert.match(bunExecutableSha256, /^[0-9a-f]{64}$/);
  // With the executable accepted, every notice is checked too.
  const accepted = sha256('a substituted runtime');
  await assert.rejects(verifyBunRuntime(directory, accepted), { code: 'ENOENT' });
  for (const notice of bunNotices) await writeFile(join(directory, notice.file), 'tampered');
  await assert.rejects(
    verifyBunRuntime(directory, accepted),
    /Bun notice checksum mismatch: LICENSE\.md/,
  );
});

test('every notice comes from a pinned commit of an official repository', () => {
  const files = new Set();
  for (const notice of bunNotices) {
    assert.match(
      notice.url,
      /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/[\w./-]+$/,
    );
    assert.match(notice.sha256, /^[0-9a-f]{64}$/);
    assert(!files.has(notice.file), `Two notices share ${notice.file}`);
    files.add(notice.file);
  }
});

test('only the qualified macOS arm64 runtime is prepared', async () => {
  const fetch = async () => assert.fail('No download for an unqualified target');
  await assert.rejects(prepareBun({ arch: 'x64', platform: 'darwin', fetch }), /x64/);
  await assert.rejects(prepareBun({ arch: 'arm64', platform: 'linux', fetch }), /macOS/);
});
