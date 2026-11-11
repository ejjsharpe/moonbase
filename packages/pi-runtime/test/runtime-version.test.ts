import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive, PiRuntimeLive } from '../src/index.ts';

const session = { host: { hostId: 'version-host', storeId: 'version-store' }, actorId: 'owner' };
type Versions = Partial<Record<'node' | 'bun' | 'electron', string>>;

// Opens one store in each mode, with the runtime reporting `versions` while it opens.
async function openStores(versions?: Versions) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-runtime-version-')));
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const original = Object.getOwnPropertyDescriptor(process, 'versions')!;
  if (versions)
    Object.defineProperty(process, 'versions', {
      ...original,
      value: { ...process.versions, bun: undefined, electron: undefined, ...versions },
    });
  try {
    const results: Record<'local' | 'host', { code?: unknown; message?: unknown } | 'opened'> = {
      local: 'opened',
      host: 'opened',
    };
    for (const mode of ['local', 'host'] as const) {
      const databasePath = join(directory, `${mode}.sqlite`);
      const runtime = ManagedRuntime.make(
        mode === 'local'
          ? LocalPiRuntimeLive({ ...session, models, databasePath })
          : PiRuntimeLive({ ...session, models, databasePath, cwd: directory, model }),
      );
      try {
        await makeChatClient(runtime).command('getChatHost', { host: session.host });
      } catch (error) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        results[mode] = { code, message };
        // A refused runtime never creates or opens the store.
        await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
      } finally {
        await runtime.dispose();
      }
    }
    return results;
  } finally {
    Object.defineProperty(process, 'versions', original);
    await rm(directory, { recursive: true, force: true });
  }
}

const opened = { local: 'opened', host: 'opened' };

test('the running runtime opens local and host-mode stores', async () => {
  if (process.versions.bun) assert.equal(process.versions.bun, '1.4.4');
  assert.deepEqual(await openStores(), opened);
});

test('only exactly Bun 1.4.4, although it reports an older Node, or Node 26.13 or newer opens a store', async () => {
  const refused = (results: Awaited<ReturnType<typeof openStores>>) =>
    Object.values(results).every((result) => result !== 'opened' && result.code === 'Incompatible');
  assert.deepEqual(await openStores({ bun: '1.4.4', node: '26.3.0' }), opened);
  assert(refused(await openStores({ bun: '1.4.5', node: '26.13.0' })));
  assert.deepEqual(await openStores({ node: '26.13.0' }), opened);
  assert(refused(await openStores({ node: '26.12.9' })));
});
