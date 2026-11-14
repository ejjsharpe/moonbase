import assert from 'node:assert/strict';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { WorkspaceLive } from './workspace-live-fixture.ts';
const [root, dataDirectory, filesystemHelper, ripgrepExecutable] = process.argv.slice(2);
const runtime = ManagedRuntime.make(
  WorkspaceLive({ hostId: 'asset-test', dataDirectory, filesystemHelper, ripgrepExecutable }),
);
try {
  const client = makeEditorClient(runtime),
    checkout = await client.command('openCheckout', { root }),
    target = { checkout, path: 'file.txt' };
  const disk = await client.command('readFile', target);
  assert.equal(disk.text, 'disk');
  assert.equal(
    (
      await client.command('saveFile', {
        target,
        clientId: 'example',
        requestId: 'save',
        expectedVersion: disk.version,
        text: 'saved from isolated assets',
      })
    ).kind,
    'saved',
  );
  const lookup = await client.command('lookupFiles', { checkout, query: 'file' });
  assert.equal(lookup.matches[0].path, 'file.txt');
  assert(!lookup.partial, lookup.error ?? 'unexpected partial');
  console.log('Independent workspace assets passed with restricted PATH.');
} finally {
  await runtime.dispose();
}
