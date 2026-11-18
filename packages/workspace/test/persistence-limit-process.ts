import assert from 'node:assert/strict';
import { ManagedRuntime } from 'effect';
import { makeWorkspaceClient } from './workspace-client-fixture.ts';
import { isStorageFailure } from '@moonbase/contracts/error-groups';
import { bufferIdOf, draftsOf, seed } from './recovery-fixture.ts';
import { WorkspaceLive } from './workspace-live-fixture.ts';
process.on('SIGXFSZ', () => {});
const [root, dataDirectory] = process.argv.slice(2);
const runtime = ManagedRuntime.make(WorkspaceLive({ hostId: 'size-limited-test', dataDirectory }));
const client = makeWorkspaceClient(runtime);
try {
  const checkout = await client.command('openCheckout', { root }),
    target = { checkout, path: 'file.txt' };
  const disk = await client.command('readFile', target);
  await seed(client, 'alice', [{ target, text: 'initial draft', disk }]);
  await assert.rejects(
    client.command('updateDraft', {
      clientId: 'alice',
      bufferId: bufferIdOf(target),
      text: 'x'.repeat(1024 * 1024),
      disk,
    }),
    isStorageFailure,
  );
  assert.equal(
    draftsOf((await client.command('loadRecovery', { clientId: 'alice' })).state)[0]?.text,
    'initial draft',
  );
  console.log(
    'Filesystem size limit: failed SQLite growth is visible and original recovery retained.',
  );
} finally {
  await runtime.dispose();
}
