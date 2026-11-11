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

const incompatible = {
  code: 'Incompatible',
  message:
    'The Pi host requires Node 26.13 or newer, or exactly Bun 1.4.4. The remote client has its own runtime boundary.',
};

test('the running runtime opens local and host-mode stores', async () => {
  if (process.versions.bun) assert.equal(process.versions.bun, '1.4.4');
  assert.deepEqual(await openStores(), { local: 'opened', host: 'opened' });
});

test('exactly Bun 1.4.4 opens both modes, although it reports an older Node', async () => {
  assert.deepEqual(await openStores({ bun: '1.4.4', node: '26.3.0' }), {
    local: 'opened',
    host: 'opened',
  });
});

test('unqualified Bun versions are refused in both modes with Incompatible', async () => {
  for (const bun of ['1.4.3', '1.4.5', '1.5.0', '2.0.0'])
    assert.deepEqual(
      await openStores({ bun, node: '26.13.0' }),
      { local: incompatible, host: incompatible },
      bun,
    );
});

test('Node 26.13 or newer opens both modes and older Node is refused', async () => {
  for (const node of ['26.13.0', '26.14.1', '27.0.0'])
    assert.deepEqual(await openStores({ node }), { local: 'opened', host: 'opened' }, node);
  for (const node of ['26.12.9', '26.3.0', '24.22.1'])
    assert.deepEqual(await openStores({ node }), { local: incompatible, host: incompatible }, node);
});

test('Electron opens no store: its Node is too old, and local chat runs in the daemon', async () => {
  for (const electron of ['45.1.0', '45.2.0'])
    assert.deepEqual(await openStores({ electron, node: '24.22.1' }), {
      local: incompatible,
      host: incompatible,
    });
});
