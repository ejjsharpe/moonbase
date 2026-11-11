import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bunVersion, prepareBun } from './prepare-bun.mjs';

const caches = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('moonbase-bun-'));

test('a Bun download that fails its pinned checksum or request fails the build and keeps the previous runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-prepare-bun-')),
    output = join(directory, 'tools', 'bun');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'bun'), 'previous runtime');
  const before = await caches();
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
      prepareBun({ output, arch: 'arm64', platform: 'darwin', fetch }),
      (rejected) => error.test(rejected.message),
    );
  }
  // Only the pinned official release was requested, and nothing past the failed archive.
  assert.deepEqual(requested, [
    `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip`,
    `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip`,
  ]);
  assert.equal(await readFile(join(output, 'bun'), 'utf8'), 'previous runtime');
  assert.deepEqual(await readdir(join(directory, 'tools')), ['bun']);
  assert.deepEqual(await caches(), before, 'A download cache outlived the failed build');
});

test('only the qualified macOS arm64 runtime is prepared', async () => {
  const fetch = async () => assert.fail('No download for an unqualified target');
  await assert.rejects(prepareBun({ arch: 'x64', platform: 'darwin', fetch }), /x64/);
  await assert.rejects(prepareBun({ arch: 'arm64', platform: 'linux', fetch }), /macOS/);
});
