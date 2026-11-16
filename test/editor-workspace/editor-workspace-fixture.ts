import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ManagedRuntime } from 'effect';
import type { RecoveryState } from '@moonbase/contracts/recovery';
import { type ApplicationError } from '@moonbase/contracts/workspace';
import {
  acquireEditorDriver,
  toWorkspaceClient,
  type EditorDriver,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { WorkspaceLocalLive } from '@moonbase/workspace';
import { getFailureCode } from '@moonbase/application/editor';

export { answering } from '@moonbase/application/testing/editor-fixture';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Polls `read` until `done` holds of its value, for state another process or window settles. */
export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  ms = 20000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw Error('Condition did not settle.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export const code = (expected: ApplicationError['code']) => (error: unknown) =>
  getFailureCode(error) === expected;

/** The drafts a stored recovery holds, by path. */
export const listDrafts = (state: RecoveryState) =>
  Object.fromEntries(
    state.buffers.flatMap((buffer) =>
      buffer.draft ? [[buffer.target.path, buffer.draft] as const] : [],
    ),
  );
/** The paths of a checkout's tabs in a stored recovery, in order. */
export const listTabs = (state: RecoveryState, checkoutId: string) =>
  (state.views[checkoutId]?.tabs ?? []).map(
    (id) => state.buffers.find((buffer) => buffer.id === id)!.target.path,
  );

/**
 * Two Git checkouts (`a.ts` committed as HEAD, staged as INDEX and WORKING on disk; `b.ts`;
 * `folder/nested.ts`) and one recovery store, with runtimes and editors over them. `launch`
 * starts a fresh runtime on the same store, as a restart would.
 */
export function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-editor-workspace-')));
  const roots = [join(base, 'alpha'), join(base, 'beta')],
    dataDirectory = join(base, 'store');
  for (const root of roots) {
    mkdirSync(root);
    mkdirSync(join(root, 'folder'));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', [
        '-C',
        root,
        '-c',
        'user.name=Moonbase integration',
        '-c',
        'user.email=integration@example.invalid',
        ...args,
      ]);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.ts'), 'HEAD\n');
    writeFileSync(join(root, 'b.ts'), 'B\n');
    writeFileSync(join(root, 'folder/nested.ts'), 'NESTED\n');
    git('add', '.');
    git('commit', '-qm', 'Controlled initial files');
    writeFileSync(join(root, 'a.ts'), 'INDEX\n');
    git('add', 'a.ts');
    writeFileSync(join(root, 'a.ts'), 'WORKING\n');
  }
  const runtimes: ReturnType<typeof start>[] = [],
    editors: EditorDriver[] = [];
  function start() {
    const runtime = ManagedRuntime.make(
      WorkspaceLocalLive({
        hostId: 'editor-workspace-local',
        installationId: 'editor-workspace',
        dataDirectory,
        filesystemHelper: createRequire(import.meta.url).resolve('@moonbase/workspace/filesystem'),
        ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP ?? resolve('dist/tools/ripgrep/rg'),
      }),
    );
    return { runtime, client: toWorkspaceClient(runtime) };
  }
  const launch = () => {
    const value = start();
    runtimes.push(value);
    return value;
  };
  const current = launch();
  /** A loaded editor on the latest runtime; `client` defaults to that runtime's. */
  async function editor(clientId: string, client?: WorkspaceClient) {
    const latest = runtimes.at(-1)!;
    const value = await acquireEditorDriver({ client: client ?? latest.client, clientId });
    editors.push(value);
    await value.load();
    return value;
  }
  /** Disposes every editor and runtime without flushing, then starts a fresh runtime. */
  async function restart() {
    for (const value of editors) await value.dispose();
    for (const value of runtimes) await value.runtime.dispose();
    return launch();
  }
  /** A client's stored recovery, read through the latest runtime. */
  const loadRecovery = async (clientId: string) =>
    (await runtimes.at(-1)!.client.command('loadRecovery', { clientId })).state;
  return {
    ...current,
    base,
    roots,
    dataDirectory,
    editor,
    launch,
    restart,
    loadRecovery,
    async close() {
      for (const value of editors) await value.dispose();
      for (const value of runtimes) await value.runtime.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
