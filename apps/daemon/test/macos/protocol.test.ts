import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ProviderState } from '@moonbase/contracts/providers';
import { LocalHostService, ProviderSetupService } from '@moonbase/contracts/services';
import {
  bounded,
  connectClients,
  readJson,
  startDaemon,
  until,
  withRoot,
} from '../daemon-fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode } from '../faux-provider.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };
// The test entry composes the file host, so it advertises the workspace.
const capabilities = [
  'chat-v0',
  'daemon-local-v1',
  'providers-v1',
  'folders-v1',
  'rpc-v1',
  'workspace-v2',
];

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
      // Git lists the folder whether or not this machine has ripgrep on PATH.
      execFileSync('git', ['init', '-q'], { cwd: project });
      await clients.run(
        folders.approveFolder({ host: session.host, requestId: 'approve-project', path: project }),
      );
      assert.deepEqual(await clients.run(folders.listRecentFolders({ host: session.host })), {
        folders: [project],
      });
      // A local daemon has no approved roots to list; its client has a native picker.
      await assert.rejects(clients.run(folders.listHostFolders({ host: session.host })), {
        _tag: 'IncompatibleHostError',
        reason: 'not-served',
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
        { _tag: 'FolderRefusedError', refusal: 'not-chat-folder' },
      );
      await clients.run(
        folders.markFolderAsProject({ requestId: 'mark-own', target: own.conversation.target }),
      );
      assert.equal(
        (await clients.chat.command('getChat', { target: own.conversation.target })).conversation
          .ownFolder,
        undefined,
      );

      // ChatGPT sign-in: the daemon returns the validated link, the client opens it. Two watches
      // of one document share its subscription, and another document's never sees the flow.
      const owner = clients.owner('document-one');
      const leaving: ProviderState[] = [],
        kept: ProviderState[] = [],
        others: ProviderState[] = [];
      const leave = owner.watch(
          (state) => leaving.push(state),
          () => {},
        ),
        closeKept = owner.watch(
          (state) => kept.push(state),
          () => {},
        ),
        closeOther = clients.owner('document-two').watch(
          (state) => others.push(state),
          () => {},
        );
      await until(async () => leaving.length && kept.length && others.length, Boolean);
      const flow = (await owner.command('startProviderLogin', { providerId: 'openai' })).flow!;
      const waiting = await until(
        () => owner.command('getProviders', {}),
        (state) => !!state.flow?.canOpenUrl && state.flow.prompt?.type === 'manual_code',
      );
      await owner.command('openProviderUrl', { flowId: flow.id });
      assert.equal(clients.opened.length, 1);
      assert.match(clients.opened[0]!, /^https:\/\/auth\.openai\.com\//);
      assert.equal((await clients.owner('document-two').command('getProviders', {})).flow, null);
      // One watch leaving keeps the other following the flow.
      await until(
        async () => leaving.at(-1)?.flow?.id,
        (id) => id === flow.id,
      );
      await leave();
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
      await until(
        async () => kept.at(-1)?.flow?.state,
        (state) => state === 'completed',
      );
      assert.equal(
        others.some((state) => state.flow),
        false,
      );
      await Promise.all([closeKept(), closeOther()]);
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
