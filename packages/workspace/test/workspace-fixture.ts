import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { makeWorkspaceClient } from './workspace-client-fixture.ts';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceLive } from './workspace-live-fixture.ts';
import { initRepository } from './repository-fixture.ts';

export function fixture(options: { ripgrepExecutable?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-workspace-'))),
    root = join(base, 'repo'),
    dataDirectory = join(base, 'state');
  mkdirSync(root);
  initRepository(root);
  const start = () => {
    const runtime = ManagedRuntime.make(
      WorkspaceLive({
        dataDirectory,
        hostId: 'local-test',
        ...(process.env.MOONBASE_TEST_RIPGREP
          ? { ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP }
          : {}),
        ...options,
      }),
    );
    return { runtime, client: makeWorkspaceClient(runtime) };
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
/** Captures native files through the host, as a native picker's owner does. */
export const captureNative = (input: {
  checkout: CheckoutTarget;
  clientId: string;
  paths: string[];
}) =>
  Effect.flatMap(WorkspaceHostService, (host) =>
    Effect.map(host.captureImports(input), (captured) => captured.references),
  );
/** Releases captured native files through the host. */
export const releaseNative = (input: {
  checkout: CheckoutTarget;
  clientId: string;
  references: string[];
}) => Effect.flatMap(WorkspaceHostService, (host) => host.releaseImports(input));
