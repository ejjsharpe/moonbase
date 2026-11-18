import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ManagedRuntime } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { makeWorkspaceRunner, type WorkspaceRunner } from './workspace-client-fixture.ts';
import { WorkspaceRecoveryLive } from '@moonbase/workspace';
import { createDaemonWorkspaceHost } from '../../src/main/daemon/workspace-host.ts';
import type { LocalDaemon } from '../../src/main/daemon/local-daemon.ts';

/** The editor's workspace as main composes it, over `local`; its store is in a temporary profile. */
export async function composeWorkspace(
  t: TestContext,
  userData: string,
  local: Pick<LocalDaemon['Service'], 'connect'>,
) {
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
  return { runtime, workspace: makeWorkspaceRunner(runtime) };
}
/** A temporary profile; `stops` run in order, even after a failure, before the profile is removed. */
export async function temporaryProfile(t: TestContext, stops: (() => Promise<unknown>)[] = []) {
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
export const one = { text: 'one', version: createHash('sha256').update('one').digest('hex') };
/** Opens `a.txt` of `target` as buffer `a` with `text` over `disk`, as the editor does. */
export async function editDraft(
  workspace: WorkspaceRunner,
  target: CheckoutTarget,
  text: string,
  disk = one,
) {
  const clientId = 'desktop-primary';
  await workspace((w) =>
    w.openTab({ clientId, bufferId: 'a', target: { checkout: target, path: 'a.txt' } }),
  );
  await workspace((w) => w.updateDraft({ clientId, bufferId: 'a', text, disk }));
}
export const draftsOf = (load: { state: { buffers: { draft?: { text: string } }[] } }) =>
  load.state.buffers.flatMap((b) => (b.draft ? [b.draft] : []));
