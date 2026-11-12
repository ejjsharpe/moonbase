import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { makeConnectionClient } from '@moonbase/application/runtime/clients';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import { RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import { connectDaemonSocket } from '@moonbase/daemon-protocol/socket';
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
import { createFauxProviders, fauxModelId, fauxProviderId } from './faux.ts';

const minute = 60_000;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** The error code a refused workspace call carries. */
const refusal = async <A>(effect: Effect.Effect<A, { code: string }>) =>
  (await run(Effect.flip(effect))).code;
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
 * serves, as a client reaches it: `RemoteWorkspaceHostLive` over the daemon's WebSocket.
 * `settings` is written to `daemon.json` the first time. Aborting is what SIGTERM does.
 */
async function startDaemon(
  root: string,
  { settings, time }: { settings?: object; time?: ControlledClock } = {},
) {
  const directory = join(root, 'data'),
    controller = new AbortController();
  const helper = findFilesystemHelper(import.meta.url, { fromSource: true });
  assert.ok(
    helper &&
      (await stat(helper).then(
        () => true,
        () => false,
      )),
    'the prebuilt filesystem helper is missing: build packages/workspace first (dist/filesystem)',
  );
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (settings)
    await writeFile(join(directory, 'daemon.json'), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(join(directory, 'faux.json'), '{}');
  const ready = Promise.withResolvers<void>();
  let settled: DaemonExit | Error | undefined;
  const running = runDaemon({
    directory,
    signal: controller.signal,
    ready: () => ready.resolve(),
    closeClaudeCode: async () => {},
    filesystemHelper: helper,
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
  const identity = await readJson(join(directory, 'identity.json'));
  const clients = ManagedRuntime.make(
    RemoteWorkspaceHostLive({ host: identity.host }).pipe(
      Layer.provideMerge(LoopbackConnectionLive({ directory })),
    ),
  );
  await makeConnectionClient(clients).command('connect', { profileId: 'loopback' });
  const host = await clients.runPromise(WorkspaceHostService);
  return {
    directory,
    host,
    abort: () => controller.abort(),
    running,
    get settled() {
      return settled;
    },
    stop: async () => {
      await clients.dispose().catch(() => {});
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
const portOf = async (directory: string) =>
  (await readJson(join(directory, 'endpoint.json'))).port as number;
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
      // Holding reserved state is `InvalidInput`; any other root inside the data directory is refused by policy.
      for (const path of [
        daemon.directory,
        root,
        join(daemon.directory, 'credentials'),
        join(daemon.directory, 'workspace'),
      ])
        assert.equal(await refusal(open(path)), 'InvalidInput', path);
      assert.equal(await refusal(open(join(daemon.directory, 'logs'))), 'Unauthorized');
      assert.equal((await run(open(join(daemon.directory, 'chats', 'one')))).vcs, 'none');
    } finally {
      await daemon.stop();
    }
  });
});

test('a daemon advertises the workspace, saves and reads 2 MiB over the wire, and a file change reaches a watch', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'a.txt'), 'old');
    const daemon = await startDaemon(root);
    const events: { ready?: boolean }[] = [];
    try {
      const checkout = await run(daemon.host.openCheckout({ root: project }));
      const disk = await run(daemon.host.readFile({ checkout, path: 'a.txt' }));
      // Large enough that its request and reply are each many frames.
      const text = '"quoted"\n'.repeat(Math.floor((2 * 1024 * 1024) / 9));
      const saved = await run(
        daemon.host.saveFile({
          installationId: 'test',
          clientId: 'window',
          requestId: 'big-save',
          target: { checkout, path: 'a.txt' },
          text,
          expectedVersion: disk.version,
        }),
      );
      assert.equal(saved.kind, 'saved');
      assert.equal((await run(daemon.host.readFile({ checkout, path: 'a.txt' }))).text, text);

      const stream = Effect.runFork(
        Stream.runForEach(daemon.host.watch({ checkout, paths: [''] }), (event) =>
          Effect.sync(() => void events.push(event)),
        ),
      );
      await until(
        async () => events.length,
        (count) => count > 0,
      );
      const before = events.length;
      await writeFile(join(project, 'b.txt'), 'new file');
      await until(
        async () => events.length,
        (count) => count > before,
      );
      await Effect.runPromise(Fiber.interrupt(stream));
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
    // A root that is itself a repository has its `-worktrees` folder outside every root.
    const solo = join(root, 'solo');
    await mkdir(solo);
    git(solo, 'init', '-q', '-b', 'main');
    git(solo, 'commit', '-q', '--allow-empty', '-m', 'initial');
    const daemon = await startDaemon(root, {
      settings: {
        mode: 'host',
        port: await findFreePort(),
        approvedRoots: [work, solo],
        credentialKey: { source: 'file', path: keyFile },
      },
    });
    try {
      const open = (path: string) => daemon.host.openCheckout({ root: path });
      const a = await run(open(join(work, 'a')));
      assert.equal(a.root, join(work, 'a'));
      for (const path of [outside, join(work, 'out-link'), join(work, 'in-link')])
        assert.equal(await refusal(open(path)), 'Unauthorized', path);
      // Holding or being the credential key's folder is reserved state.
      for (const path of [root, join(root, 'keys')])
        assert.equal(await refusal(open(path)), 'InvalidInput', path);
      await run(daemon.host.verifyCheckout({ checkout: a }));

      // A worktree can't be created outside the approved roots.
      git(join(work, 'a'), 'init', '-q', '-b', 'main');
      git(join(work, 'a'), 'commit', '-q', '--allow-empty', '-m', 'initial');
      const repo = await run(open(join(work, 'a')));
      assert.equal(
        await refusal(
          daemon.host.createWorktree({
            installationId: 'test',
            requestId: 'outside-1',
            checkout: repo,
            base: 'main',
            branch: 'feature/outside',
            location: join(outside, 'tree'),
          }),
        ),
        'Unauthorized',
      );

      // A chat worktree is made inside a root, never beside a root that is itself the repository.
      const chatWorktree = (requestId: string, root: string) =>
        daemon.host.createChatWorktree({ installationId: 'test', requestId, root, branch: 'chat' });
      assert.equal(
        (await run(chatWorktree('inside', join(work, 'a')))).root,
        join(work, 'a-worktrees', 'chat'),
      );
      assert.equal(await refusal(chatWorktree('beside', solo)), 'Unauthorized');
      await assert.rejects(stat(join(root, 'solo-worktrees')));
      // Native imports are never held for a host: their sources are held to no root.
      assert.equal(
        await refusal(daemon.host.captureImports({ checkout: a, clientId: 'w', paths: [outside] })),
        'Incompatible',
      );

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

test('a local daemon lets chats use its checkouts and worktrees, makes chat worktrees and turns a chat into a project', async () => {
  await withRoot(async (root) => {
    const repo = join(root, 'repo'),
      stray = join(root, 'stray');
    await mkdir(repo);
    await mkdir(stray);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'initial');
    const daemon = await startDaemon(root);
    const identity = await readJson(join(daemon.directory, 'identity.json'));
    const host = identity.host,
      session = { host, actorId: identity.actorId };
    const socket = await connectDaemonSocket({
      origin: `http://127.0.0.1:${await portOf(daemon.directory)}`,
      token: (await readFile(join(daemon.directory, 'token'), 'utf8')).trim(),
      expected: host,
    });
    const model = { provider: fauxProviderId, modelId: fauxModelId };
    const approved = (path: string) =>
      socket.request('checkApprovedFolder', { host, path }).then(
        () => true,
        () => false,
      );
    try {
      assert.equal(await approved(repo), false);
      const checkout = await run(daemon.host.openCheckout({ root: repo }));
      // The editor's checkout needs no grant from the picker.
      assert.equal(await approved(repo), true);
      assert.equal(await approved(stray), false);
      await socket.request('createChat', {
        session,
        requestId: 'in-checkout',
        title: 'In the checkout',
        settings: { cwd: repo, model },
      });

      const request = {
        installationId: 'test',
        requestId: 'worktree',
        root: repo,
        branch: 'chat/a',
      };
      const made = await run(daemon.host.createChatWorktree(request));
      assert.equal(made.root, join(root, 'repo-worktrees', 'chat-a'));
      assert.deepEqual(await run(daemon.host.createChatWorktree(request)), made);
      assert.equal(await approved(made.root), true);
      await socket.request('createChat', {
        session,
        requestId: 'in-worktree',
        title: 'In the worktree',
        settings: { cwd: made.root, model },
      });

      // A chat's own folder opens where it is; a chat in a project is not one the daemon made.
      const own = await socket.request('createChat', {
        session,
        requestId: 'own',
        title: 'Own folder',
        settings: { model },
      });
      const turn = (requestId: string, target: typeof own.conversation.target) =>
        daemon.host.turnChatIntoProject({ installationId: 'test', requestId, target });
      const inProject = await socket.request('createChat', {
        session,
        requestId: 'project-chat',
        title: 'In a project',
        settings: { cwd: repo, model },
      });
      assert.equal(await refusal(turn('refused', inProject.conversation.target)), 'Unauthorized');
      const turned = await run(turn('turn', own.conversation.target));
      assert.equal(turned.root, own.conversation.cwd);
      assert.deepEqual(await run(turn('turn', own.conversation.target)), turned);
      const { conversation } = await socket.request('getChat', { target: own.conversation.target });
      assert.equal(conversation.ownFolder, undefined);

      // A checkout replaced after it was approved grants chats nothing, nor do its worktrees.
      await rename(repo, join(root, 'repo-old'));
      await mkdir(repo);
      assert.equal(await approved(repo), false);
      await assert.rejects(
        socket.request('createChat', {
          session,
          requestId: 'replaced',
          title: 'Replaced',
          settings: { cwd: repo, model },
        }),
        { code: 'Unauthorized' },
      );
      assert.equal(await refusal(daemon.host.verifyCheckout({ checkout })), 'Unauthorized');
    } finally {
      socket.close();
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
    const running = runDaemon({
      directory,
      signal: controller.signal,
      ready: () => ready.resolve(),
      closeClaudeCode: async () => {},
      providers: () => createFauxProviders(directory),
    });
    await bounded(ready.promise);
    // Without a file host the daemon advertises no workspace and refuses its operations.
    const identity = await readJson(join(directory, 'identity.json'));
    const socket = await connectDaemonSocket({
      origin: `http://127.0.0.1:${await portOf(directory)}`,
      token: (await readFile(join(directory, 'token'), 'utf8')).trim(),
      expected: identity.host,
    });
    assert.ok(!socket.health.capabilities.includes('workspace-v1'));
    await assert.rejects(socket.request('openCheckout', { root }), { code: 'Incompatible' });
    await socket.close();
    controller.abort();
    assert.equal(await running, 'stopped');
  });
});
