import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedRuntime } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
  type FileDocument,
} from '@moonbase/contracts/workspace';
import type { RecoveryLayout, RecoveryState } from '@moonbase/contracts/recovery';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { isWorkspaceHostError, toWireError } from '@moonbase/contracts/workspace-host-errors';
import { WorkspaceLive } from './workspace-live-fixture.ts';
import { initRepository } from './repository-fixture.ts';
export const binary = fileURLToPath(new URL('../dist/filesystem', import.meta.url));
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-review-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  initRepository(root);
  writeFileSync(join(root, 'file.txt'), 'original');
  const start = (filesystemHelper = binary) => {
    const runtime = ManagedRuntime.make(
      WorkspaceLive({ dataDirectory, hostId: 'review-host', filesystemHelper }),
    );
    return { runtime, client: makeEditorClient(runtime) };
  };
  const wrapper = (body: string) => {
    const path = join(base, 'helper-' + Math.random());
    writeFileSync(path, '#!/bin/sh\n' + body + '\nexec ' + quote(binary) + ' "$@"\n');
    chmodSync(path, 0o700);
    return path;
  };
  return {
    base,
    root,
    start,
    wrapper,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
/** Whether `value` is, or a host error sent as, the wire error with `code`. */
export const isError = (code: ApplicationError['code']) => (value: unknown) => {
  const wire = isWorkspaceHostError(value) ? toWireError(value) : value;
  return ApplicationError.is(wire) && wire.code === code;
};
type Target = { checkout: CheckoutTarget; path: string };
export type SeedDraft = { target: Target; text: string; disk: FileDocument; bufferId?: string };
/** A buffer's ID as `seed` opens it. */
export const bufferIdOf = (target: Target) =>
  (target.checkout.checkoutId + '.' + target.path).replaceAll(/[^\w.-]/g, '_');
/**
 * Seeds a client's recovery through its edits, as an editor does: the drafts' checkouts open in
 * the layout (the first selected, and `layout` over that), then each draft open as a buffer with
 * its text over its disk.
 */
export async function seed(
  client: Pick<EditorClient, 'command'>,
  clientId: string,
  drafts: SeedDraft[],
  layout: Partial<RecoveryLayout> = {},
) {
  const checkouts = [
    ...new Map(drafts.map((d) => [d.target.checkout.checkoutId, d.target.checkout])).values(),
  ];
  await client.command('updateLayout', {
    clientId,
    layout: {
      checkouts,
      openCheckoutIds: checkouts.map((c) => c.checkoutId),
      selectedCheckoutId: checkouts[0]?.checkoutId ?? null,
      views: {},
      recentFiles: [],
      sidebarWidth: 270,
      followActiveFile: true,
      ...layout,
    },
  });
  for (const { target, text, disk, bufferId = bufferIdOf(target) } of drafts) {
    await client.command('openTab', { clientId, bufferId, target });
    await client.command('updateDraft', { clientId, bufferId, text, disk });
  }
}
/** A recovery's drafts as where they are, their text and the file text they were edited over. */
export const draftsOf = (state: RecoveryState) =>
  state.buffers.flatMap((b) => (b.draft ? [{ target: b.target, ...b.draft }] : []));
export async function waitFor(path: string) {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) {
    assert(Date.now() < deadline, 'native helper did not reach barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
