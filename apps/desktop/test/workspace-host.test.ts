import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  ConnectionService,
  WorkspaceHostService,
  type WorkspaceHostServiceShape,
} from '@moonbase/contracts/services';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import { emptyRecovery, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import { WorkspaceRecoveryLive } from '@moonbase/workspace';
import {
  createLocalDaemon,
  findDaemonDirectory,
  LocalDaemonConnectionLive,
  readDaemonSession,
  restartDaemon,
} from '../src/main/daemon/local-daemon.ts';
import { createDaemonWorkspaceHost } from '../src/main/daemon/workspace-host.ts';
import {
  createLocalDaemonClient,
  type LocalDaemonClient,
} from '../src/main/daemon/local-daemon-client.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
} from './fixtures/faux-daemon.mjs';

const unavailable = new ApplicationError({ code: 'Unavailable', message: 'No daemon.' });

type Local = Pick<LocalDaemonClient, 'connect'>;
/** A reached daemon serving `workspace`, advertising the workspace unless `files` is false. */
const reached = (workspace: Partial<WorkspaceHostServiceShape>, files = true): Local => ({
  connect: () =>
    Effect.succeed({
      workspace,
      endpoint: {
        health: { capabilities: files ? [chatHostCapabilities.workspace] : [] },
      },
    }) as never,
});

/** The editor's workspace as main composes it, over `local`; its store is in a temporary profile. */
async function composeWorkspace(t: TestContext, userData: string, local: Local) {
  const runtime = ManagedRuntime.make(
    WorkspaceRecoveryLive(
      {
        dataDirectory: join(userData, 'workspace-v1'),
        installationId: 'test-installation',
      },
      createDaemonWorkspaceHost(local),
    ),
  );
  t.after(() => runtime.dispose());
  return { runtime, client: makeEditorClient(runtime) };
}
/** A temporary profile; `stops` run in order, even after a failure, before the profile is removed. */
async function temporaryProfile(t: TestContext, stops: (() => Promise<unknown>)[] = []) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-workspace-client-')));
  t.after(async () => {
    try {
      for (const stop of stops) await stop().catch(() => undefined);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
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
  // The client main builds: a failed attempt is answered again for a moment.
  const local = createLocalDaemonClient(
    async () => {
      attempts++;
      throw unavailable;
    },
    () => clock,
  );
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
    reached({ verifyCheckout: () => Effect.void }),
  );
  await seeded.client.command('persistRecovery', {
    clientId: 'desktop-primary',
    requestId: randomUUID(),
    expectedRevision: 0,
    state: draftState(target, 'before'),
  });
  await seeded.runtime.dispose();
  const first = await composeWorkspace(t, userData, local);
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
  const second = await composeWorkspace(t, userData, local);
  const reloaded = await second.client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.equal(reloaded.state.drafts[0].text, 'unsaved work');
  assert(reloaded.errors.length > 0);
});

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
    connect: () =>
      Effect.tryPromise({
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
  assert.equal(again.text, onDisk ? 'edited' : 'one');
  assert.equal(daemon.isRunning(), true);
  assert.notEqual(await readDaemonPid(directory), before);
  // The save is settled now: its text is on disk or in the draft, and nothing is left unresolved.
  const settled = await client.command('loadRecovery', { clientId: 'desktop-primary' });
  assert.deepEqual(settled.errors, []);
});

test('a call that can’t reach the daemon within its deadline is Unavailable, and only a daemon without files is told apart', async () => {
  const target = {
    checkout: {
      hostId: 'host',
      checkoutId: 'checkout',
      projectId: 'project',
      root: '/project',
      vcs: 'none' as const,
    },
    path: 'a.txt',
  };
  const read = (local: Local, deadlineMs?: () => number) =>
    Effect.runPromise(createDaemonWorkspaceHost(local, deadlineMs).readFile(target));
  await assert.rejects(
    read({ connect: () => Effect.never }, () => 10),
    { code: 'Unavailable' },
  );
  const invalid = new ApplicationError({ code: 'Incompatible', message: 'Invalid reply.' });
  const refusing = { readFile: () => Effect.fail(invalid) };
  await assert.rejects(read(reached(refusing)), invalid);
  await assert.rejects(read(reached(refusing, false)), { code: 'Unavailable' });
});

test('Restart daemon asks first, then stops the daemon and starts it again', async () => {
  const steps: string[] = [],
    reported: string[] = [];
  const daemon = {
    stop: async () => {
      steps.push('stop');
      return true;
    },
  };
  const start = async () => void steps.push('start');
  const report = (message: string) => void reported.push(message);
  await restartDaemon({ daemon, start, confirm: async () => false, report });
  assert.deepEqual(steps, []);
  await restartDaemon({ daemon, start, confirm: async () => true, report });
  assert.deepEqual(steps, ['stop', 'start']);
  await restartDaemon({
    daemon: {
      stop: async () => {
        throw new Error('Still stopping.');
      },
    },
    start,
    confirm: async () => true,
    report,
  });
  assert.deepEqual(steps, ['stop', 'start']);
  assert.equal(reported.length, 1);
});
