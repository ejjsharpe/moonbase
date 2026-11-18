import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { findDaemonDirectory } from '../../src/main/daemon/daemon-files.ts';
import { LocalDaemon, LocalDaemonLive } from '../../src/main/daemon/local-daemon.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
} from '../fixtures/faux-daemon.mjs';
import {
  composeWorkspace,
  draftsOf,
  editDraft,
  temporaryProfile,
} from '../fixtures/workspace-host-fixture.ts';

test('a save sent as the daemon is stopped keeps its text, and resolves once the daemon is back', async (t) => {
  const stops: (() => Promise<unknown>)[] = [];
  const userData = await temporaryProfile(t, stops);
  await prepareDaemonData(userData);
  const directory = findDaemonDirectory(userData);
  // Stop the daemon and any replacement it started, while the endpoint file still exists.
  stops.push(() => stopDaemon(directory));
  const project = join(userData, 'project');
  await mkdir(project);
  await writeFile(join(project, 'a.txt'), 'one');
  // The local daemon main builds: it starts a stopped daemon on the next request.
  const runtime = ManagedRuntime.make(
    LocalDaemonLive({
      directory,
      command: makeFauxDaemonCommand(directory),
      openUrl: async () => {},
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  stops.unshift(() => runtime.dispose());
  const local = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* LocalDaemon;
    }),
  );
  const { client } = await composeWorkspace(t, userData, local);

  const checkout = await client.command('openCheckout', { root: project });
  const disk = await client.command('readFile', { checkout, path: 'a.txt' });
  await editDraft(client, checkout, 'edited', disk);
  const save = {
    target: { checkout, path: 'a.txt' },
    clientId: 'desktop-primary',
    requestId: 'save-while-down',
    text: 'edited',
    expectedVersion: disk.version,
  };
  const before = await readDaemonPid(directory);
  // The daemon is stopped (what Restart daemon does) just as the editor saves.
  await stopDaemon(directory);
  const sent = await client.command('saveFile', save).then(
    (result) => result,
    (error: unknown) => error,
  );
  const loaded = await client.command('loadRecovery', { clientId: 'desktop-primary' });
  // Whether the request reached the old daemon or not, the text is in a draft or on disk, never lost.
  const onDisk = (await readFile(join(project, 'a.txt'), 'utf8')) === 'edited';
  assert(onDisk || draftsOf(loaded).some((d) => d.text === 'edited'), String(sent));
  // The next request started a new daemon in a new connection, and files are served again.
  const again = await client.command('readFile', { checkout, path: 'a.txt' });
  assert.equal(again.text, onDisk ? 'edited' : 'one');
  assert.equal(await Effect.runPromise(local.isRunning), true);
  assert.notEqual(await readDaemonPid(directory), before);
  // The save is settled now: its text is on disk or in the draft, and nothing is left unresolved.
  const settled = await client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.deepEqual(settled.errors, []);
});
