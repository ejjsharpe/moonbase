import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ProviderState } from '@moonbase/contracts/providers';
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
    const clients = await connectClients(directory, ready.host);
    try {
      const connected = await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      assert.equal(connected.state, 'connected');
      assert.deepEqual(
        connected.state === 'connected' && connected.health.capabilities,
        capabilities,
      );
      assert.equal(connected.profile.remotePort, ready.port);
      const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
      assert(!JSON.stringify(connected).includes(token));
      // Connecting again to the same daemon keeps the generation.
      const again = await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      assert.equal(again.connectionId, connected.connectionId);
      // The token outlives a restart, so a daemon restarted on the same port is told apart by its
      // process: an endpoint naming another pid starts a new generation.
      const endpointPath = join(directory, 'endpoint.json');
      const endpoint = await readJson(endpointPath);
      await writeFile(endpointPath, JSON.stringify({ ...endpoint, pid: endpoint.pid + 1 }));
      await chmod(endpointPath, 0o600);
      const replaced = await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      assert.equal(replaced.state, 'connected');
      assert.notEqual(replaced.connectionId, connected.connectionId);
      await assert.rejects(
        clients.run(clients.connection.disconnect({ connectionId: connected.connectionId! })),
        { _tag: 'ConnectionError', reason: 'stale-generation' },
      );

      const { folders } = clients;
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
      const created = await clients.run(
        clients.chat.createChat({
          session,
          requestId: 'create-project',
          title: 'Over loopback',
          settings: { cwd: project, model },
        }),
      );
      assert.equal(created.conversation.cwd, project);
      const found = await clients.run(
        clients.chat.findChatFiles({
          session,
          cwd: project,
          query: 'readme',
        }),
      );
      assert.deepEqual(
        found.matches.map((match) => match.path),
        ['readme.md'],
      );
      const views: ChatSnapshot[] = [];
      const close = clients.watch(
        clients.chat.watch({ target: created.conversation.target }),
        (snapshot) => views.push(snapshot),
      );
      try {
        await clients.run(
          clients.chat.sendChat({
            target: created.conversation.target,
            requestId: 'send-project',
            text: 'Hello daemon',
          }),
        );
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

      const own = await clients.run(
        clients.chat.createChat({
          session,
          requestId: 'create-own',
          title: 'No project',
          settings: { model },
        }),
      );
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
        (await clients.run(clients.chat.getChat({ target: own.conversation.target }))).conversation
          .ownFolder,
        undefined,
      );

      // ChatGPT sign-in: the daemon returns the validated link, the client opens it. Two watches
      // of one document share its subscription, and another document's never sees the flow.
      const owner = clients.providers.forOwner('document-one');
      const watchOwner = (ownerId: string, states: ProviderState[]) =>
        clients.watch(clients.providers.watch(ownerId), (state) => states.push(state));
      const leaving: ProviderState[] = [],
        kept: ProviderState[] = [],
        others: ProviderState[] = [];
      const leave = watchOwner('document-one', leaving),
        closeKept = watchOwner('document-one', kept),
        closeOther = watchOwner('document-two', others);
      await until(async () => leaving.length && kept.length && others.length, Boolean);
      const flow = (await clients.run(owner.startProviderLogin({ providerId: 'openai' }))).flow!;
      const waiting = await until(
        () => clients.run(owner.getProviders({})),
        (state) => !!state.flow?.canOpenUrl && state.flow.prompt?.type === 'manual_code',
      );
      await clients.run(owner.openProviderUrl({ flowId: flow.id }));
      assert.equal(clients.opened.length, 1);
      assert.match(clients.opened[0]!, /^https:\/\/auth\.openai\.com\//);
      assert.equal(
        (await clients.run(clients.providers.forOwner('document-two').getProviders({}))).flow,
        null,
      );
      // One watch leaving keeps the other following the flow.
      await until(
        async () => leaving.at(-1)?.flow?.id,
        (id) => id === flow.id,
      );
      await leave();
      await clients.run(
        owner.answerProviderPrompt({
          flowId: flow.id,
          promptId: waiting.flow!.prompt!.id,
          answer: fauxSignInCode,
        }),
      );
      const signedIn = await until(
        () => clients.run(owner.getProviders({})),
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
      const out = await clients.run(owner.logoutProvider({ providerId: 'openai' }));
      assert.equal(out.providers.find((p) => p.id === 'openai')?.configured, false);
      await clients.run(clients.providers.releaseOwner('document-one'));
      await assert.rejects(clients.run(owner.getProviders({})), {
        _tag: 'ProviderSetupRefusedError',
        reason: 'owner-released',
      });

      // A restarted daemon listens elsewhere; connecting again finds it as a new generation.
      await daemon.stop();
      await assert.rejects(clients.run(clients.connection.connect({ profileId: 'loopback' })), {
        _tag: 'ConnectionError',
        reason: 'daemon-not-running',
      });
      assert.equal((await clients.run(clients.connection.getConnection({}))).state, 'failed');
      await assert.rejects(clients.run(clients.chat.getChatHost({ host: session.host })), {
        _tag: 'ConnectionError',
        reason: 'not-verified',
      });
      const restarted = startDaemon([directory]);
      started.push(restarted);
      await bounded(restarted.ready);
      const reconnected = await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      assert.equal(reconnected.state, 'connected');
      assert.notEqual(reconnected.connectionId, replaced.connectionId);
      const listed = await clients.run(clients.chat.listChats({ session }));
      assert.equal(listed.conversations.length, 2);
      await clients.run(clients.connection.disconnect({ connectionId: reconnected.connectionId! }));
      await assert.rejects(clients.run(clients.chat.listChats({ session })), {
        _tag: 'ConnectionError',
        reason: 'not-verified',
      });
    } finally {
      await clients.runtime.dispose();
    }
  });
});
