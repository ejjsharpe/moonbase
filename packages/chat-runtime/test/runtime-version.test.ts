import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive } from '../src/index.ts';

const session = { host: { hostId: 'version-host', storeId: 'version-store' }, actorId: 'owner' };
type Versions = Partial<Record<'node' | 'bun' | 'electron', string>>;

// Opens a store with the runtime reporting `versions` while it opens; returns the refusal's code.
async function openStore(versions?: Versions) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-runtime-version-')));
  const databasePath = join(directory, 'chat.sqlite');
  const original = Object.getOwnPropertyDescriptor(process, 'versions')!;
  if (versions)
    Object.defineProperty(process, 'versions', {
      ...original,
      value: { ...process.versions, bun: undefined, electron: undefined, ...versions },
    });
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({ ...session, models: createModels(), databasePath }),
  );
  try {
    await makeChatClient(runtime).command('getChatHost', { host: session.host });
    return 'opened';
  } catch (error) {
    // A refused runtime never creates or opens the store.
    await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
    return (error as { code?: unknown }).code;
  } finally {
    Object.defineProperty(process, 'versions', original);
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test('the running runtime opens a store', async () => {
  if (process.versions.bun) assert.equal(process.versions.bun, '1.4.4');
  assert.equal(await openStore(), 'opened');
});

test('only exactly Bun 1.4.4, although it reports an older Node, or Node 26.13 or newer opens a store', async () => {
  assert.equal(await openStore({ bun: '1.4.4', node: '26.3.0' }), 'opened');
  assert.equal(await openStore({ bun: '1.4.5', node: '26.13.0' }), 'Incompatible');
  assert.equal(await openStore({ node: '26.13.0' }), 'opened');
  assert.equal(await openStore({ node: '26.12.9' }), 'Incompatible');
});
