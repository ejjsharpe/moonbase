import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { isWorkspaceHostError, toWireError } from '@moonbase/contracts/workspace-host-errors';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import {
  ApplicationError,
  emptyRecovery,
  type CheckoutTarget,
  type EditorRecovery,
} from '@moonbase/contracts/workspace';
import { WorkspaceLive } from './workspace-live-fixture.ts';

export function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-workspace-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  const start = () => {
    const runtime = ManagedRuntime.make(
      WorkspaceLive({
        dataDirectory,
        hostId: 'local-test',
        ...(process.env.MOONBASE_TEST_RIPGREP
          ? { ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP }
          : {}),
      }),
    );
    return { runtime, client: makeEditorClient(runtime) };
  };
  const instance = start();
  return {
    ...instance,
    base,
    root,
    dataDirectory,
    start,
    async close() {
      await instance.runtime.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
/** Whether `error` is, or a host error sent as, the wire error with `code`. */
export const rejects = (code: ApplicationError['code']) => (error: unknown) => {
  const wire = isWorkspaceHostError(error) ? toWireError(error) : error;
  return wire instanceof ApplicationError && wire.code === code;
};
/** Captures native files through the host, as a native picker's owner does. */
export const captureNative = (input: {
  checkout: CheckoutTarget;
  clientId: string;
  paths: string[];
}) =>
  Effect.flatMap(WorkspaceHostService, (host) =>
    Effect.map(host.captureImports(input), (captured) => captured.references),
  ).pipe(Effect.mapError(toWireError));
/** Releases captured native files through the host. */
export const releaseNative = (input: {
  checkout: CheckoutTarget;
  clientId: string;
  references: string[];
}) =>
  Effect.flatMap(WorkspaceHostService, (host) => host.releaseImports(input)).pipe(
    Effect.mapError(toWireError),
  );
export function draft(
  clientId: string,
  checkout: CheckoutTarget,
  text: string,
  disk: { text: string; version: string },
): EditorRecovery {
  return {
    ...emptyRecovery(clientId),
    checkouts: [checkout],
    openCheckoutIds: [checkout.checkoutId],
    selectedCheckoutId: checkout.checkoutId,
    drafts: [{ target: { checkout, path: 'file.txt' }, text, disk }],
  };
}
