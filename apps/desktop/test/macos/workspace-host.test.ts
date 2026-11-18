import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/errors';
import { ConnectionService, WorkspaceHostService } from '@moonbase/contracts/services';
import { RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import {
  createLocalDaemon,
  findDaemonDirectory,
  LocalDaemonConnectionLive,
  readDaemonSession,
} from '../../src/main/daemon/local-daemon.ts';
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
  const command = makeFauxDaemonCommand(directory);
  // Stop the handle's daemon and any replacement it started, while the endpoint file still exists.
  stops.push(() => stopDaemon(directory));
  const project = join(userData, 'project');
  await mkdir(project);
  await writeFile(join(project, 'a.txt'), 'one');
  const daemon = createLocalDaemon({ directory, command });
  stops.unshift(() => daemon.stop());
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  // The daemon connection is the one main builds: it starts a stopped daemon on the next request.
  const connection = ManagedRuntime.make(
    RemoteWorkspaceHostLive({ host: session.host }).pipe(
      Layer.provideMerge(LocalDaemonConnectionLive(daemon)),
    ),
  );
  stops.unshift(() => connection.dispose());
  const { client } = await composeWorkspace(t, userData, {
    connect: Effect.tryPromise({
      try: () =>
        connection.runPromise(
          Effect.gen(function* () {
            const connections = yield* ConnectionService;
            return {
              workspace: yield* WorkspaceHostService,
              endpoint: yield* connections.endpoint({ host: session.host }),
            };
          }),
        ),
      catch: (error) => error as ApplicationError,
    }) as never,
  });

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
  assert.equal(await daemon.stop(), true);
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
  assert.equal(daemon.isRunning(), true);
  assert.notEqual(await readDaemonPid(directory), before);
  // The save is settled now: its text is on disk or in the draft, and nothing is left unresolved.
  const settled = await client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.deepEqual(settled.errors, []);
});
