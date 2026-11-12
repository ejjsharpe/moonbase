import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { runDaemon, type DaemonExit } from '../src/daemon.ts';
import { findFilesystemHelper } from '../src/workspace.ts';
import {
  bounded,
  createControlledClock,
  findFreePort,
  readJson,
  temporaryRoot,
  until,
  type ControlledClock,
} from './fixture.ts';
import { createFauxProviders } from './faux.ts';

const minute = 60_000;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** The error code a refused workspace call carries. */
const refusal = async <A>(effect: Effect.Effect<A, { code: string }>) =>
  (await run(Effect.flip(effect))).code;
/** A root the policy refuses is `Unauthorized`; one that holds reserved state is `InvalidInput`. */
const refused = ['InvalidInput', 'Unauthorized'];
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/**
 * Runs a daemon in this process on `root/data` with faux providers and hands back the file host it
 * serves, as a test-only client. `settings` is written to `daemon.json` the first time. Aborting
 * is what SIGTERM does.
 */
async function startDaemon(
  root: string,
  { settings, time }: { settings?: object; time?: ControlledClock } = {},
) {
  const directory = join(root, 'data'),
    controller = new AbortController();
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (settings)
    await writeFile(join(directory, 'daemon.json'), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(join(directory, 'faux.json'), '{}');
  const host = Promise.withResolvers<WorkspaceHostServiceShape>();
  const ready = Promise.withResolvers<void>();
  let settled: DaemonExit | Error | undefined;
  const running = runDaemon({
    directory,
    signal: controller.signal,
    ready: () => ready.resolve(),
    closeClaudeCode: async () => {},
    filesystemHelper: findFilesystemHelper(import.meta.url),
    receiveWorkspace: host.resolve,
    ...(time ? { clock: time.clock } : {}),
    providers: (loaded) => ({
      ...createFauxProviders(directory),
      ...(loaded.credentialKey?.source === 'file'
        ? { keySource: createKeyFileSource(loaded.credentialKey.path) }
        : {}),
    }),
  }).then(
    (exit) => (settled = exit),
    (error: Error) => (settled = error),
  );
  void running.then(() => ready.resolve());
  await bounded(ready.promise);
  if (settled instanceof Error) throw settled;
  return {
    directory,
    host: await bounded(host.promise),
    abort: () => controller.abort(),
    running,
    get settled() {
      return settled;
    },
    stop: () => {
      controller.abort();
      return running;
    },
  };
}

async function withRoot(body: (root: string) => Promise<void>) {
  const root = await temporaryRoot();
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', [
    '-C',
    cwd,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@e.invalid',
    ...args,
  ]);

test('a local daemon opens its own host id and refuses its data directory, what holds it and its secrets, but opens a chats folder', async () => {
  await withRoot(async (root) => {
    const daemon = await startDaemon(root);
    try {
      const open = (path: string) => daemon.host.openCheckout({ root: path });
      const project = join(root, 'project');
      await mkdir(project);
      const target = await run(open(project));
      const identity = await readJson(join(daemon.directory, 'identity.json'));
      assert.equal(target.hostId, identity.host.hostId);
      assert.equal((await stat(join(daemon.directory, 'workspace'))).mode & 0o777, 0o700);

      await mkdir(join(daemon.directory, 'credentials'), { recursive: true });
      await mkdir(join(daemon.directory, 'chats', 'one'), { recursive: true });
      // The data directory, a folder holding it (and so its token) and the secrets inside it.
      for (const path of [
        daemon.directory,
        root,
        join(daemon.directory, 'credentials'),
        join(daemon.directory, 'workspace'),
        join(daemon.directory, 'logs'),
      ])
        assert.ok(refused.includes(await refusal(open(path))), path);
      assert.equal((await run(open(join(daemon.directory, 'chats', 'one')))).vcs, 'none');
    } finally {
      await daemon.stop();
    }
  });
});

test('a host-mode daemon opens only roots under approvedRoots by real path, and not once a root is replaced', async () => {
  await withRoot(async (root) => {
    const work = join(root, 'work'),
      outside = join(root, 'outside');
    for (const path of [join(work, 'a'), join(work, 'b'), outside])
      await mkdir(path, { recursive: true });
    await symlink(outside, join(work, 'out-link'));
    await symlink(join(work, 'b'), join(work, 'in-link'));
    const keyFile = join(root, 'keys', 'credential.key');
    await mkdir(join(root, 'keys'), { mode: 0o700 });
    const daemon = await startDaemon(root, {
      settings: {
        mode: 'host',
        port: await findFreePort(),
        approvedRoots: [work],
        credentialKey: { source: 'file', path: keyFile },
      },
    });
    try {
      const open = (path: string) => daemon.host.openCheckout({ root: path });
      const a = await run(open(join(work, 'a')));
      assert.equal(a.root, join(work, 'a'));
      for (const path of [
        outside,
        root,
        join(work, 'out-link'),
        join(work, 'in-link'),
        join(root, 'keys'),
      ])
        assert.ok(refused.includes(await refusal(open(path))), path);
      await run(daemon.host.verifyCheckout({ checkout: a }));

      // The root becomes another folder: it approves nothing new and nothing opened under it.
      await rename(work, join(root, 'work-old'));
      await mkdir(join(work, 'a'), { recursive: true });
      assert.equal(await refusal(open(join(work, 'a'))), 'Unauthorized');
      assert.equal(await refusal(daemon.host.verifyCheckout({ checkout: a })), 'Unauthorized');
    } finally {
      await daemon.stop();
    }
  });
});

test('stopping during a long helper operation stops its process group, exits cleanly, counts as use and keeps a save for the next start', async () => {
  await withRoot(async (root) => {
    const repo = join(root, 'repo'),
      pidFile = join(root, 'hook.pid'),
      time = createControlledClock();
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'secret-name.txt'), 'file text that never reaches the log');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
    // The hook runs inside `git worktree add`, so the creation stays busy until it is stopped.
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 300\n`);
    await chmod(hook, 0o755);

    const first = await startDaemon(root, { time });
    const checkout = await run(first.host.openCheckout({ root: repo }));
    const disk = await run(first.host.readFile({ checkout, path: 'secret-name.txt' }));
    const request = { installationId: 'alice', clientId: 'window', requestId: 'save-1' };
    await run(
      first.host.saveFile({
        ...request,
        target: { checkout, path: 'secret-name.txt' },
        text: 'saved text',
        expectedVersion: disk.version,
      }),
    );
    const creating = run(
      first.host.createWorktree({
        installationId: 'alice',
        requestId: 'create-1',
        checkout,
        base: 'main',
        branch: 'feature/hidden-branch',
        location: join(root, 'worktree'),
      }),
    ).catch((error: unknown) => error);
    const pid = Number(
      await until(
        () => readFile(pidFile, 'utf8').catch(() => ''),
        (text) => text.trim() !== '',
      ),
    );
    // The operation in flight keeps a local daemon from idling out.
    await time.advance(6 * minute);
    assert.equal(first.settled, undefined);

    first.abort();
    assert.equal(await refusal(first.host.verifyCheckout({ checkout })), 'Unavailable');
    assert.equal(await bounded(first.running, 30_000), 'stopped');
    assert.ok(gone(pid), 'the hook outlived the daemon');
    assert.ok(await creating);

    const second = await startDaemon(root);
    try {
      const status = await run(second.host.saveStatus(request));
      assert.equal(status.kind, 'saved');
      assert.equal(await readFile(join(repo, 'secret-name.txt'), 'utf8'), 'saved text');
    } finally {
      await second.stop();
    }
    const log = await readFile(join(first.directory, 'logs', 'daemon.log'), 'utf8');
    for (const secret of [root, 'secret-name', 'feature/hidden-branch', 'file text', 'saved text'])
      assert.ok(!log.includes(secret), 'the log keeps ' + secret);
  });
});

test('a daemon without the filesystem helper composes no workspace and still runs', async () => {
  await withRoot(async (root) => {
    const directory = join(root, 'data'),
      controller = new AbortController(),
      ready = Promise.withResolvers<void>();
    let received = 0;
    const running = runDaemon({
      directory,
      signal: controller.signal,
      ready: () => ready.resolve(),
      closeClaudeCode: async () => {},
      receiveWorkspace: () => received++,
      providers: () => createFauxProviders(directory),
    });
    await bounded(ready.promise);
    controller.abort();
    assert.equal(await running, 'stopped');
    assert.equal(received, 0);
  });
});
