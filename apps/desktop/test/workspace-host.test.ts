import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { BrowserWindow, Dialog } from 'electron';
import { restartDaemon } from '../src/main/daemon/restart-daemon.ts';
import { createDaemonWorkspaceHost } from '../src/main/daemon/workspace-host.ts';
import type { LocalDaemon } from '../src/main/daemon/local-daemon.ts';
import { LocalDaemonError } from '@moonbase/contracts/connection-errors';
import {
  composeWorkspace,
  draftsOf,
  editDraft,
  one,
  temporaryProfile,
} from './fixtures/workspace-host-fixture.ts';

type Local = Pick<LocalDaemon['Service'], 'connect'>;
/** A reached daemon serving `workspace`, advertising the workspace unless `files` is false. */
const reached = (workspace: Partial<WorkspaceHostServiceShape>, files = true): Local => ({
  connect: Effect.succeed({
    workspace,
    endpoint: {
      health: { capabilities: files ? [chatHostCapabilities.workspace] : [] },
    },
  }) as never,
});

test('without a reachable daemon the store keeps drafts and files are unavailable', async (t) => {
  const userData = await temporaryProfile(t);
  const local: Local = { connect: Effect.fail(new LocalDaemonError({ reason: 'unreachable' })) };
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
  await editDraft(seeded.workspace, target, 'before');
  await seeded.runtime.dispose();
  const first = await composeWorkspace(t, userData, local);
  await first.workspace((w) => w.loadRecovery({ clientId: 'desktop-primary' }));
  // Edits keep being kept without the daemon.
  await first.workspace((w) =>
    w.updateDraft({
      clientId: 'desktop-primary',
      bufferId: 'a',
      text: 'unsaved work',
      disk: one,
    }),
  );
  const unreachable = { _tag: 'LocalDaemonError', reason: 'unreachable' };
  await assert.rejects(
    first.workspace((w) => w.openCheckout({ root: target.root })),
    unreachable,
  );
  await assert.rejects(
    first.workspace((w) => w.listDirectory({ checkout: target, path: '' })),
    unreachable,
  );
  // Quit or a reload with the daemon down: the draft is still there, with the failure reported.
  await first.runtime.dispose();
  const second = await composeWorkspace(t, userData, local);
  const reloaded = await second.workspace((w) => w.loadRecovery({ clientId: 'desktop-primary' }));
  assert.equal(draftsOf(reloaded)[0]?.text, 'unsaved work');
  assert(reloaded.errors.length > 0);
});

test('a call that can’t reach the daemon within its deadline is unavailable, and only a daemon without files is told apart', async () => {
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
    read({ connect: Effect.never }, () => 10),
    { _tag: 'LocalDaemonError', reason: 'reach-timeout' },
  );
  const invalid = new IncompatibleHostError({ reason: 'invalid-reply' });
  const refusing = { readFile: () => Effect.fail(invalid) };
  await assert.rejects(read(reached(refusing)), invalid);
  await assert.rejects(read(reached(refusing, false)), {
    _tag: 'LocalDaemonError',
    reason: 'without-files',
  });
});

test('Restart daemon asks first, then restarts the daemon, reporting a failure', async () => {
  const steps: string[] = [],
    reported: string[] = [];
  let confirm = 0;
  const dialog = {
    showMessageBox: async () => ({ response: confirm, checkboxChecked: false }),
    showErrorBox: (_title: string, message: string) => void reported.push(message),
  } as unknown as Pick<Dialog, 'showMessageBox' | 'showErrorBox'>;
  const restart = (
    daemon: Pick<LocalDaemon['Service'], 'restart'> = {
      restart: Effect.sync(() => void steps.push('restart')),
    },
  ) => Effect.runPromise(restartDaemon({ daemon, dialog, window: {} as BrowserWindow }));
  await restart();
  assert.deepEqual(steps, []);
  confirm = 1;
  await restart();
  assert.deepEqual(steps, ['restart']);
  await restart({ restart: Effect.fail(new LocalDaemonError({ reason: 'still-stopping' })) });
  assert.deepEqual(steps, ['restart']);
  assert.deepEqual(reported, [new LocalDaemonError({ reason: 'still-stopping' }).message]);
});
