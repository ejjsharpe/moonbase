import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { WorkspaceHostLive, WorkspaceRecoveryLive } from '../src/index.ts';

/** One file host and any number of client stores over it, as a daemon and its clients are. */
export function harness() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-split-'))),
    root = join(base, 'repo');
  mkdirSync(root);
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', root]);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ]).toString();
  const runtimes: { dispose(): Promise<void> }[] = [];
  let clock = 1_000;
  const startHost = async (retention = 60_000, name = 'host', hostId = 'split-host') => {
    const runtime = ManagedRuntime.make(
      WorkspaceHostLive(
        {
          dataDirectory: join(base, name),
          hostId,
          journalRetentionMs: retention,
        },
        () => clock,
      ),
    );
    runtimes.push(runtime);
    return { runtime, host: await runtime.runPromise(WorkspaceHostService) };
  };
  /** A client store whose host calls may be wrapped to lose a request or its reply. */
  const startClient = (
    name: string,
    host: WorkspaceHostServiceShape,
    lose?: (host: WorkspaceHostServiceShape) => WorkspaceHostServiceShape,
    hostWaitMs?: number,
  ) => {
    const runtime = ManagedRuntime.make(
      WorkspaceRecoveryLive(
        {
          dataDirectory: join(base, name),
          installationId: name,
          hostWaitMs,
        },
        lose ? lose(host) : host,
      ),
    );
    runtimes.push(runtime);
    return { runtime, client: makeEditorClient(runtime) };
  };
  return {
    base,
    root,
    git,
    startHost,
    startClient,
    advance: (ms: number) => (clock += ms),
    async close() {
      for (const runtime of runtimes.reverse()) await runtime.dispose().catch(() => {});
      rmSync(base, { recursive: true, force: true });
    },
  };
}
export const lost = new ApplicationError({
  code: 'Unavailable',
  message: 'The host did not answer.',
});
export const dropRequest =
  <K extends 'saveFile' | 'mutate'>(operation: K) =>
  (host: WorkspaceHostServiceShape): WorkspaceHostServiceShape => ({
    ...host,
    [operation]: () => Effect.fail(lost),
  });
/** The host commits, then the link goes down: the reply and every status query are lost. */
export const dropReply =
  <K extends 'saveFile' | 'mutate' | 'createWorktree'>(
    operation: K,
    failure: ApplicationError = lost,
  ) =>
  (host: WorkspaceHostServiceShape): WorkspaceHostServiceShape => ({
    ...host,
    [operation]: (input: never) =>
      Effect.flatMap(
        (host[operation] as (input: never) => Effect.Effect<unknown, ApplicationError>)(input),
        () => Effect.fail(failure),
      ),
    saveStatus: () => Effect.fail(lost),
    operationStatus: () => Effect.fail(lost),
  });
export const openCheckout = (host: WorkspaceHostServiceShape, root: string) =>
  Effect.runPromise(host.openCheckout({ root }));
