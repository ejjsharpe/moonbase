import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/errors';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { emptyRecovery, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import { WorkspaceRecoveryLive } from '@moonbase/workspace';
import {
  createLocalDaemon,
  findDaemonDirectory,
  LocalDaemonConnectionLive,
  readDaemonSession,
  restartDaemon,
} from '../src/main/local-daemon.ts';
import { createDaemonWorkspaceHost } from '../src/main/workspace-host.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
} from './faux-daemon.mjs';

const unavailable = new ApplicationError({ code: 'Unavailable', message: 'No daemon.' });

/** The editor's workspace as main composes it, over `reach`; its store is in a temporary profile. */
async function composeWorkspace(
  t: TestContext,
  userData: string,
  reach: () => Promise<WorkspaceHostServiceShape>,
  now?: () => number,
) {
  const runtime = ManagedRuntime.make(
    WorkspaceRecoveryLive(
      {
        dataDirectory: join(userData, 'workspace-v1'),
        installationId: 'test-installation',
      },
      createDaemonWorkspaceHost(reach, now),
    ),
  );
  t.after(() => runtime.dispose());
  return { runtime, client: makeEditorClient(runtime) };
}
async function temporaryProfile(t: TestContext) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-workspace-client-')));
  t.after(() => rm(userData, { recursive: true, force: true }));
  return userData;
}
const draftState = (
  target: CheckoutTarget,
  text: string,
  disk = { text: 'one', version: createHash('sha256').update('one').digest('hex') },
) => ({
  ...emptyRecovery('desktop-primary'),
  checkouts: [target],
  openCheckoutIds: [target.checkoutId],
  selectedCheckoutId: target.checkoutId,
  drafts: [
    {
      target: { checkout: target, path: 'a.txt' },
      text,
      disk,
    },
  ],
});

test('without a reachable daemon the store keeps drafts, files are unavailable, and a failed attempt is not repeated at once', async (t) => {
  const userData = await temporaryProfile(t);
  let attempts = 0,
    clock = 0;
  const reach = async (): Promise<WorkspaceHostServiceShape> => {
    attempts++;
    throw unavailable;
  };
  const target: CheckoutTarget = {
    hostId: 'host',
    checkoutId: 'checkout',
    projectId: 'project',
    root: join(userData, 'project'),
    vcs: 'none',
  };
  // The checkout was opened while the daemon was up.
  const seeded = await composeWorkspace(
    t,
    userData,
    async () =>
      ({
        verifyCheckout: () => Effect.void,
      }) as unknown as WorkspaceHostServiceShape,
  );
  await seeded.client.command('persistRecovery', {
    clientId: 'desktop-primary',
    requestId: randomUUID(),
    expectedRevision: 0,
    state: draftState(target, 'before'),
  });
  await seeded.runtime.dispose();
  const first = await composeWorkspace(t, userData, reach, () => clock);
  const load = await first.client.command('loadRecovery', { clientId: 'desktop-primary' });
  // Edits keep being kept without the daemon.
  await first.client.command('persistRecovery', {
    clientId: 'desktop-primary',
    requestId: randomUUID(),
    expectedRevision: load.revision,
    state: draftState(target, 'unsaved work'),
  });
  await assert.rejects(first.client.command('openCheckout', { root: target.root }), {
    code: 'Unavailable',
  });
  await assert.rejects(first.client.command('listDirectory', { checkout: target, path: '' }), {
    code: 'Unavailable',
  });
  assert.equal(attempts, 1, 'a second call reuses the failed attempt');
  clock += 5000;
  await assert.rejects(first.client.command('gitStatus', { checkout: target }));
  assert.equal(attempts, 2);
  // Quit or a reload with the daemon down: the draft is still there, with the failure reported.
  await first.runtime.dispose();
  const second = await composeWorkspace(t, userData, reach, () => clock);
  const reloaded = await second.client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.equal(reloaded.state.drafts[0].text, 'unsaved work');
  assert(reloaded.errors.length > 0);
});

test('a save sent as the daemon is stopped keeps its text, and resolves once the daemon is back', async (t) => {
  const userData = await temporaryProfile(t);
  await prepareDaemonData(userData);
  const directory = findDaemonDirectory(userData);
  const command = makeFauxDaemonCommand(directory);
  t.after(() => stopDaemon(directory));
  const project = join(userData, 'project');
  await mkdir(project);
  await writeFile(join(project, 'a.txt'), 'one');
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  // The daemon connection is the one main builds: it starts a stopped daemon on the next request.
  const connection = ManagedRuntime.make(
    RemoteWorkspaceHostLive({ host: session.host }).pipe(
      Layer.provideMerge(LocalDaemonConnectionLive(daemon)),
    ),
  );
  t.after(() => connection.dispose());
  const { client } = await composeWorkspace(t, userData, () =>
    connection.runPromise(
      Effect.gen(function* () {
        return yield* WorkspaceHostService;
      }),
    ),
  );

  const checkout = await client.command('openCheckout', { root: project });
  const disk = await client.command('readFile', { checkout, path: 'a.txt' });
  await client.command('persistRecovery', {
    clientId: 'desktop-primary',
    requestId: randomUUID(),
    expectedRevision: 0,
    state: draftState(checkout, 'edited', disk),
  });
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
  assert(onDisk || loaded.state.drafts.some((d) => d.text === 'edited'), String(sent));
  // The next request started a new daemon in a new connection, and files are served again.
  const again = await client.command('readFile', { checkout, path: 'a.txt' });
  assert(again.text === 'edited' || again.text === 'one');
  assert.equal(daemon.isRunning(), true);
  assert.notEqual(await readDaemonPid(directory), before);
  // The save is settled now: its text is on disk or in the draft, and nothing is left unresolved.
  const settled = await client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.deepEqual(settled.errors, []);
});

test('Restart daemon asks first, and stops the daemon only when confirmed', async () => {
  const stopped: string[] = [],
    reported: string[] = [];
  const daemon = {
    stop: async () => {
      stopped.push('stop');
      return true;
    },
  };
  await restartDaemon({ daemon, confirm: async () => false, report: (m) => reported.push(m) });
  assert.deepEqual(stopped, []);
  await restartDaemon({ daemon, confirm: async () => true, report: (m) => reported.push(m) });
  assert.deepEqual(stopped, ['stop']);
  await restartDaemon({
    daemon: {
      stop: async () => {
        throw new Error('Still stopping.');
      },
    },
    confirm: async () => true,
    report: (m) => reported.push(m),
  });
  assert.equal(reported.length, 1);
  // A stop that found no daemon to stop is reported too.
  await restartDaemon({
    daemon: { stop: async () => false },
    confirm: async () => true,
    report: (m) => reported.push(m),
  });
  assert.equal(reported.length, 2);
});
