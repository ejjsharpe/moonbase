import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import {
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import {
  makeChatClient,
  makeConnectionClient,
  makeProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/pi-runtime/remote';
import { LoopbackConnectionLive } from '@moonbase/pi-runtime/loopback';
import {
  bounded,
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

/** The clients a privileged process composes over a loopback connection to `directory`. */
function connectClients(directory: string, host: { hostId: string; storeId: string }) {
  const opened: string[] = [];
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      RemoteChatLive,
      RemoteLocalHostLive,
      RemoteProviderSetupLive({
        host,
        sameMachine: true,
        openUrl: async (url) => {
          opened.push(url);
        },
      }),
    ).pipe(Layer.provideMerge(LoopbackConnectionLive({ directory }))),
  );
  return {
    runtime,
    opened,
    chat: makeChatClient(runtime),
    connection: makeConnectionClient(runtime),
    owner: (ownerId: string) => makeProviderSetupClient(runtime, ownerId),
    run: <A>(effect: Effect.Effect<A, ApplicationError, LocalHostService | ProviderSetupService>) =>
      runtime.runPromise(effect),
  };
}

/** Builds a loopback connection alone and reports why it could not be built, if it could not. */
async function buildLoopback(directory: string) {
  const scope = Effect.runSync(Scope.make());
  try {
    const exit = await Effect.runPromiseExit(
      Layer.buildWithScope(LoopbackConnectionLive({ directory }), scope),
    );
    return Exit.isFailure(exit)
      ? (exit.cause.reasons.find((reason) => reason._tag === 'Fail') as { error: ApplicationError })
          .error.code
      : 'built';
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
      assert.notEqual(reconnected.connectionId, connected.connectionId);
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

test('the loopback connection refuses unsafe files, another protocol, another identity and a wrong token', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      other = join(root, 'other');
    assert.equal(await buildLoopback(directory), 'Unavailable', 'no daemon directory yet');
    const daemon = startDaemon([directory]),
      second = startDaemon([other]);
    started.push(daemon, second);
    const [ready] = await Promise.all([bounded(daemon.ready), bounded(second.ready)]);
    assert.equal(await buildLoopback(directory), 'built');
    await chmod(directory, 0o755);
    assert.equal(await buildLoopback(directory), 'Unavailable', 'a directory others can read');
    await chmod(directory, 0o700);
    const endpointFile = join(directory, 'endpoint.json'),
      tokenFile = join(directory, 'token'),
      identityFile = join(directory, 'identity.json');
    const endpoint = await readFile(endpointFile, 'utf8'),
      token = await readFile(tokenFile, 'utf8'),
      identity = await readFile(identityFile, 'utf8');
    await chmod(tokenFile, 0o644);
    assert.equal(await buildLoopback(directory), 'Unavailable', 'a token others can read');
    await chmod(tokenFile, 0o600);
    await writeFile(endpointFile, JSON.stringify({ ...JSON.parse(endpoint), protocol: 1 }));
    assert.equal(await buildLoopback(directory), 'Incompatible', 'an old protocol');
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
