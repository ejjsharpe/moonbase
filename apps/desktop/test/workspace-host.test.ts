import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { restartDaemon } from '../src/main/daemon/local-daemon.ts';
import { createDaemonWorkspaceHost } from '../src/main/daemon/workspace-host.ts';
import {
  createLocalDaemonClient,
  type LocalDaemonClient,
} from '../src/main/daemon/local-daemon-client.ts';
import {
  composeWorkspace,
  draftsOf,
  editDraft,
  one,
  temporaryProfile,
} from './fixtures/workspace-host-fixture.ts';

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
  await editDraft(seeded.client, target, 'before');
  await seeded.runtime.dispose();
  const first = await composeWorkspace(t, userData, local);
  await first.client.command('loadRecovery', { clientId: 'desktop-primary' });
  // Edits keep being kept without the daemon.
  await first.client.command('updateDraft', {
    clientId: 'desktop-primary',
    bufferId: 'a',
    text: 'unsaved work',
    disk: one,
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
  assert.equal(draftsOf(reloaded)[0]?.text, 'unsaved work');
  assert(reloaded.errors.length > 0);
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
