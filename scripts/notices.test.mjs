import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notices } from './notices.mjs';

test('release notice failures preserve output, reject unpinned versions and prefer package licenses', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonbase-notices-')),
    packageDirectory = join(directory, 'node_modules', 'fixture'),
    output = join(directory, 'notices.txt'),
    inputs = [join(packageDirectory, 'index.js')];
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(output, 'previous notices');
  const saveManifest = (name, version) =>
    writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name, version, license: 'MIT' }),
    );
  let status = 503,
    downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    downloads++;
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/.+\/[a-f0-9]{40}\/LICENSE$/);
    assert(options.signal instanceof AbortSignal);
    return new Response('untrusted release notice', { status });
  });
  for (const [name, version, label] of [
    ['@stylexjs/stylex', '0.19.1', 'StyleX'],
    ...['chord', 'pi-ai', 'pi-durable', 'pi-codemode', 'pi-telemetry'].map((name) => [
      '@earendil-works/' + name,
      '1.4.0',
      'Pi',
    ]),
    ['standardwebhooks', '1.1.1', 'Standard Webhooks'],
  ]) {
    await saveManifest(name, version);
    status = 503;
    await assert.rejects(notices(inputs, output), {
      message: label + ' release notice unavailable',
    });
    status = 200;
    await assert.rejects(notices(inputs, output), {
      message: label + ' release notice checksum mismatch',
    });
    assert.equal(await readFile(output, 'utf8'), 'previous notices');
  }
  const before = downloads;
  await saveManifest('@stylexjs/stylex', '0.19.2');
  await assert.rejects(notices(inputs, output), {
    message: 'No package/release-provided notice found for bundled @stylexjs/stylex@0.19.2',
  });
  assert.equal(await readFile(output, 'utf8'), 'previous notices');
  await saveManifest('@stylexjs/stylex', '0.19.1');
  await writeFile(join(packageDirectory, 'LICENSE'), 'package license');
  await notices(inputs, output);
  assert.equal(
    await readFile(output, 'utf8'),
    '@stylexjs/stylex@0.19.1 ("MIT")\n\nLICENSE\npackage license',
  );
  assert.equal(downloads, before);
});
