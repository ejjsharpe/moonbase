import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { ApplicationError, emptyRecovery } from '@moonbase/contracts/workspace';
import { WorkspaceLive } from './workspace-live-fixture.ts';
process.on('SIGXFSZ', () => {});
const [root, dataDirectory] = process.argv.slice(2);
const runtime = ManagedRuntime.make(WorkspaceLive({ hostId: 'size-limited-test', dataDirectory }));
const client = makeEditorClient(runtime);
try {
  const checkout = await client.command('openCheckout', { root }),
    target = { checkout, path: 'file.txt' };
  const disk = await client.command('readFile', target);
  const state = {
    ...emptyRecovery('alice'),
    checkouts: [checkout],
    drafts: [{ target, text: 'initial draft', disk }],
  };
  const { revision } = await client.command('persistRecovery', {
    requestId: randomUUID(),
    clientId: 'alice',
    expectedRevision: 0,
    state,
  });
  await assert.rejects(
    client.command('persistRecovery', {
      requestId: randomUUID(),
      clientId: 'alice',
      expectedRevision: revision,
      state: { ...state, drafts: [{ target, text: 'x'.repeat(1024 * 1024), disk }] },
    }),
    (error) => error instanceof ApplicationError && error.code === 'Persistence',
  );
  assert.equal(
    (await client.command('loadRecovery', { clientId: 'alice' })).state.drafts[0].text,
    'initial draft',
  );
  console.log(
    'Filesystem size limit: failed SQLite growth is visible and original recovery retained.',
  );
} finally {
  await runtime.dispose();
}
