import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import {
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import { LoopbackConnectionLive } from '@moonbase/pi-runtime/loopback';
import {
  bounded,
  connectClients,
  readJson,
  startDaemon,
  temporaryRoot,
  until,
  type DaemonProcess,
} from './fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode } from './faux.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };
const capabilities = ['chat-v0', 'daemon-local-v1', 'providers-v1', 'folders-v1'];

async function withRoot(run: (root: string, started: DaemonProcess[]) => Promise<void>) {
  const root = await temporaryRoot(),
    started: DaemonProcess[] = [];
  try {
    await run(root, started);
  } finally {
    await Promise.all(started.map((daemon) => daemon.stop('SIGKILL')));
    await rm(root, { recursive: true, force: true });
  }
}

/** The error an exit failed with, or `ok`. */
const describeExit = (exit: Exit.Exit<unknown, ApplicationError>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((reason) => reason._tag === 'Fail') as { error: ApplicationError })
        .error
    : 'ok';

/**
 * Builds a loopback connection alone, then connects it, and reports the state it reached or the
 * code (and message) that stopped it at either step.
 */
async function connectLoopback(directory: string) {
  const scope = Effect.runSync(Scope.make());
  try {
    const built = await Effect.runPromiseExit(
      Layer.buildWithScope(LoopbackConnectionLive({ directory }), scope),
    );
    const failure = describeExit(built);
    if (failure !== 'ok' || !Exit.isSuccess(built))
      return {
        step: 'build',
        code: (failure as ApplicationError).code,
        message: (failure as ApplicationError).message,
      };
    const service = Context.get(built.value, ConnectionService);
    const initial = await Effect.runPromise(service.getConnection({}));
    const connected = await Effect.runPromiseExit(service.connect({ profileId: 'loopback' }));
    const refused = describeExit(connected);
    if (refused !== 'ok')
      return {
        step: 'connect',
        initial: initial.state,
        code: refused.code,
        message: refused.message,
      };
    return {
      step: 'connect',
      initial: initial.state,
      code: Exit.isSuccess(connected) && connected.value.state,
    };
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

test('a token holder drives a local-mode daemon completely over the loopback connection', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    const daemon = startDaemon([directory]);
    started.push(daemon);
    const ready = await bounded(daemon.ready);
    const identity = await readJson(join(directory, 'identity.json'));
    const session = { host: identity.host, actorId: identity.actorId };
    const clients = connectClients(directory, ready.host);
    try {
      const connected = await clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal(connected.state, 'connected');
      assert.deepEqual(
        connected.state === 'connected' && connected.health.capabilities,
        capabilities,
      );
      assert.equal(connected.profile.remotePort, ready.port);
      const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
      assert(!JSON.stringify(connected).includes(token));
      // Connecting again to the same daemon keeps the generation.
      const again = await clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal(again.connectionId, connected.connectionId);
      // The token outlives a restart, so a daemon restarted on the same port is told apart by its
      // process: an endpoint naming another pid starts a new generation.
      const endpointPath = join(directory, 'endpoint.json');
      const endpoint = await readJson(endpointPath);
      await writeFile(endpointPath, JSON.stringify({ ...endpoint, pid: endpoint.pid + 1 }));
      await chmod(endpointPath, 0o600);
      const replaced = await clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal(replaced.state, 'connected');
      assert.notEqual(replaced.connectionId, connected.connectionId);
      await assert.rejects(
        clients.connection.command('disconnect', { connectionId: connected.connectionId! }),
        { code: 'Conflict' },
      );

      const folders = await clients.runtime.runPromise(LocalHostService);
      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, 'readme.md'), 'hello');
      await clients.run(
        folders.approveFolder({ host: session.host, requestId: 'approve-project', path: project }),
      );
      assert.deepEqual(await clients.run(folders.listRecentFolders({ host: session.host })), {
        folders: [project],
      });
      // A local daemon has no approved roots to list; its client has a native picker.
      await assert.rejects(clients.run(folders.listHostFolders({ host: session.host })), {
        code: 'Incompatible',
      });
      const created = await clients.chat.command('createChat', {
        session,
        requestId: 'create-project',
        title: 'Over loopback',
        settings: { cwd: project, model },
      });
      assert.equal(created.conversation.cwd, project);
      const found = await clients.chat.command('findChatFiles', {
        session,
        cwd: project,
        query: 'readme',
      });
      assert.deepEqual(
        found.matches.map((match) => match.path),
        ['readme.md'],
      );
      const views: ChatSnapshot[] = [];
      const close = clients.chat.watch(
        { target: created.conversation.target },
        (snapshot) => views.push(snapshot),
        () => {},
      );
      try {
        await clients.chat.command('sendChat', {
          target: created.conversation.target,
          requestId: 'send-project',
          text: 'Hello daemon',
        });
        await until(
          async () => views.at(-1),
          (snapshot) =>
            !!snapshot &&
            !snapshot.run &&
            snapshot.entries.some((entry) => entry.text === 'Faux reply'),
        );
      } finally {
        await close();
      }
      assert.deepEqual(await clients.run(folders.getActiveWork({ host: session.host })), {
        active: false,
      });

      const own = await clients.chat.command('createChat', {
        session,
        requestId: 'create-own',
        title: 'No project',
        settings: { model },
      });
      assert.equal(own.conversation.ownFolder, true);
      await clients.run(
        folders.checkChatFolder({ host: session.host, path: own.conversation.cwd }),
      );
      await assert.rejects(
        clients.run(folders.checkChatFolder({ host: session.host, path: project })),
        {
          code: 'Unauthorized',
        },
      );
      await clients.run(
        folders.markFolderAsProject({ requestId: 'mark-own', target: own.conversation.target }),
      );
      assert.equal(
        (await clients.chat.command('getChat', { target: own.conversation.target })).conversation
          .ownFolder,
        undefined,
      );

      // ChatGPT sign-in: the daemon returns the validated link, the client opens it.
      const owner = clients.owner('document-one');
      const flow = (await owner.command('startProviderLogin', { providerId: 'openai' })).flow!;
      const waiting = await until(
        () => owner.command('getProviders', {}),
        (state) => !!state.flow?.canOpenUrl && state.flow.prompt?.type === 'manual_code',
      );
      await owner.command('openProviderUrl', { flowId: flow.id });
      assert.equal(clients.opened.length, 1);
      assert.match(clients.opened[0]!, /^https:\/\/auth\.openai\.com\//);
      assert.equal((await clients.owner('document-two').command('getProviders', {})).flow, null);
      await owner.command('answerProviderPrompt', {
        flowId: flow.id,
        promptId: waiting.flow!.prompt!.id,
        answer: fauxSignInCode,
      });
      const signedIn = await until(
        () => owner.command('getProviders', {}),
        (state) => state.flow?.state === 'completed',
      );
      assert.equal(signedIn.providers.find((p) => p.id === 'openai')?.configured, true);
      const out = await owner.command('logoutProvider', { providerId: 'openai' });
      assert.equal(out.providers.find((p) => p.id === 'openai')?.configured, false);
      const providers = await clients.runtime.runPromise(ProviderSetupService);
      await clients.run(providers.releaseOwner('document-one'));
      await assert.rejects(owner.command('getProviders', {}), { code: 'InvalidInput' });

      // A restarted daemon listens elsewhere; connecting again finds it as a new generation.
      await daemon.stop();
      await assert.rejects(clients.connection.command('connect', { profileId: 'loopback' }), {
        code: 'Unavailable',
      });
      assert.equal((await clients.connection.command('getConnection', {})).state, 'failed');
      await assert.rejects(clients.chat.command('getChatHost', { host: session.host }), {
        code: 'Unavailable',
      });
      const restarted = startDaemon([directory]);
      started.push(restarted);
      await bounded(restarted.ready);
      const reconnected = await clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal(reconnected.state, 'connected');
      assert.notEqual(reconnected.connectionId, replaced.connectionId);
      const listed = await clients.chat.command('listChats', { session });
      assert.equal(listed.conversations.length, 2);
      await clients.connection.command('disconnect', { connectionId: reconnected.connectionId! });
      await assert.rejects(clients.chat.command('listChats', { session }), {
        code: 'Unavailable',
      });
    } finally {
      await clients.runtime.dispose();
    }
  });
});

const unsafeMessage = 'The daemon data directory or one of its files is not private to this user.';

test('the loopback connection builds from the identity alone while the daemon is stopped', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    const first = startDaemon([directory]);
    started.push(first);
    const { host } = await bounded(first.ready);
    await first.stop();
    await assert.rejects(readFile(join(directory, 'endpoint.json')), { code: 'ENOENT' });
    const clients = connectClients(directory, host);
    try {
      const initial = await clients.connection.command('getConnection', {});
      assert.equal(initial.state, 'disconnected');
      assert.equal(initial.profile.remotePort, undefined);
      assert.deepEqual(initial.profile.expected, host);
      await assert.rejects(clients.connection.command('connect', { profileId: 'loopback' }), {
        code: 'Unavailable',
        message: 'The daemon is not running.',
      });
      const daemon = startDaemon([directory]);
      started.push(daemon);
      const ready = await bounded(daemon.ready);
      const connected = await clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal(connected.state, 'connected');
      assert.equal(connected.profile.remotePort, ready.port);
      assert.deepEqual((await clients.chat.command('getChatHost', { host })).host, host);
    } finally {
      await clients.runtime.dispose();
    }
  });
});

test('the loopback connection never follows a link to its data directory or files', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    const daemon = startDaemon([directory]);
    started.push(daemon);
    await bounded(daemon.ready);
    assert.equal((await connectLoopback(directory)).code, 'connected');
    // Each file in turn becomes a link to an identical private copy; only the link is wrong.
    for (const [name, step] of [
      ['identity.json', 'build'],
      ['endpoint.json', 'connect'],
      ['token', 'connect'],
    ] as const) {
      const file = join(directory, name),
        copy = join(elsewhere, name);
      await rename(file, copy);
      await symlink(copy, file);
      const refused = await connectLoopback(directory);
      assert.deepEqual(
        { step: refused.step, code: refused.code, message: refused.message },
        { step, code: 'Unavailable', message: unsafeMessage },
        name,
      );
      await rm(file);
      await rename(copy, file);
      assert.equal((await connectLoopback(directory)).code, 'connected', name);
    }
    // A link to the whole private data directory is refused too.
    const linked = join(root, 'linked');
    await symlink(directory, linked);
    assert.deepEqual(await connectLoopback(linked), {
      step: 'build',
      code: 'Unavailable',
      message: unsafeMessage,
    });
  });
});

test('the loopback connection refuses unsafe files, another protocol, another identity and a wrong token', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      other = join(root, 'other');
    assert.deepEqual(
      await connectLoopback(directory),
      { step: 'build', code: 'Unavailable', message: 'The daemon is not running.' },
      'no daemon directory yet, so no identity to bind to',
    );
    const daemon = startDaemon([directory]),
      second = startDaemon([other]);
    started.push(daemon, second);
    const [ready] = await Promise.all([bounded(daemon.ready), bounded(second.ready)]);
    assert.deepEqual(await connectLoopback(directory), {
      step: 'connect',
      initial: 'disconnected',
      code: 'connected',
    });
    await chmod(directory, 0o755);
    assert.equal((await connectLoopback(directory)).step, 'build', 'a directory others can read');
    await chmod(directory, 0o700);
    const endpointFile = join(directory, 'endpoint.json'),
      tokenFile = join(directory, 'token'),
      identityFile = join(directory, 'identity.json');
    const endpoint = await readFile(endpointFile, 'utf8'),
      token = await readFile(tokenFile, 'utf8'),
      identity = await readFile(identityFile, 'utf8');
    await chmod(tokenFile, 0o644);
    assert.deepEqual(
      await connectLoopback(directory),
      { step: 'connect', initial: 'disconnected', code: 'Unavailable', message: unsafeMessage },
      'a token others can read',
    );
    await chmod(tokenFile, 0o600);
    await writeFile(endpointFile, JSON.stringify({ ...JSON.parse(endpoint), protocol: 1 }));
    assert.equal((await connectLoopback(directory)).code, 'Incompatible', 'an old protocol');
    await writeFile(endpointFile, endpoint);

    const clients = connectClients(directory, ready.host);
    try {
      const connect = () => clients.connection.command('connect', { profileId: 'loopback' });
      assert.equal((await connect()).state, 'connected');
      await assert.rejects(clients.connection.command('connect', { profileId: 'other' }), {
        code: 'InvalidInput',
      });
      const connections = await clients.runtime.runPromise(ConnectionService);
      await assert.rejects(
        clients.runtime.runPromise(
          connections.endpoint({ host: { ...ready.host, storeId: 'another-store' } }),
        ),
        { code: 'Conflict' },
      );
      // Another daemon's endpoint and token: its health names another host and store.
      await writeFile(endpointFile, await readFile(join(other, 'endpoint.json')));
      await writeFile(tokenFile, await readFile(join(other, 'token')));
      await assert.rejects(connect(), { code: 'Incompatible' });
      assert.equal((await clients.connection.command('getConnection', {})).state, 'failed');
      // The right daemon with the wrong token proves nothing.
      await writeFile(endpointFile, endpoint);
      await assert.rejects(connect(), { code: 'Unauthorized' });
      await writeFile(tokenFile, token);
      // A directory whose identity changed is another daemon.
      await writeFile(
        identityFile,
        JSON.stringify({ ...JSON.parse(identity), host: { hostId: 'x', storeId: 'y' } }),
      );
      await assert.rejects(connect(), { code: 'Incompatible' });
      await writeFile(identityFile, identity);
      assert.equal((await connect()).state, 'connected');
    } finally {
      await clients.runtime.dispose();
    }
  });
});

test('the built daemon searches files with the ripgrep shipped beside its bundle, with none on PATH', async () => {
  await withRoot(async (root, started) => {
    // The app's layout: `daemon/daemon.mjs` beside `workspace/ripgrep/rg` in its resources.
    const resources = join(root, 'Resources');
    execFileSync(process.execPath, [
      new URL('../scripts/build.mjs', import.meta.url).pathname,
      join(resources, 'daemon'),
      join(root, 'daemon-inputs.json'),
    ]);
    await mkdir(join(resources, 'workspace/ripgrep'), { recursive: true });
    const rg = join(resources, 'workspace/ripgrep/rg');
    await writeFile(rg, "#!/bin/sh\nprintf 'listed-by-bundled-ripgrep.md\\0'\n");
    await chmod(rg, 0o755);
    const directory = join(root, 'data'),
      project = join(root, 'project');
    await mkdir(directory, { mode: 0o700 });
    // Not a Git repository, so without ripgrep the search would fail.
    await mkdir(project);
    await writeFile(join(project, 'readme.md'), 'hello');
    await writeFile(join(root, 'key'), randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    await writeFile(
      join(directory, 'daemon.json'),
      JSON.stringify({ mode: 'local', credentialKey: { source: 'file', path: join(root, 'key') } }),
      { mode: 0o600 },
    );
    const daemon = startDaemon([directory], {
      entry: join(resources, 'daemon/daemon.mjs'),
      // Only the system PATH, as an app launched from Finder has: no `rg` on it.
      env: { PATH: '/usr/bin:/bin', HOME: root },
    });
    started.push(daemon);
    const ready = await bounded(daemon.ready);
    const identity = await readJson(join(directory, 'identity.json'));
    const session = { host: identity.host, actorId: identity.actorId };
    const clients = connectClients(directory, ready.host);
    try {
      await clients.connection.command('connect', { profileId: 'loopback' });
      const folders = await clients.runtime.runPromise(LocalHostService);
      await clients.run(
        folders.approveFolder({ host: session.host, requestId: 'approve', path: project }),
      );
      const found = await clients.chat.command('findChatFiles', {
        session,
        cwd: project,
        query: '',
      });
      assert.deepEqual(
        found.matches.map((match) => match.path),
        ['listed-by-bundled-ripgrep.md'],
      );
    } finally {
      await clients.runtime.dispose();
    }
    assert.deepEqual(await daemon.stop(), [0, null]);
  });
});
