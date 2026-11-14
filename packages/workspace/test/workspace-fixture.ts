import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
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
export const rejects = (code: ApplicationError['code']) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
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
