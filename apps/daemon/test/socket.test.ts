import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatOutput, ChatSnapshot } from '@moonbase/contracts/chat';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import { daemonInputSchemas } from '@moonbase/contracts/daemon-schema';
import type { ProviderState } from '@moonbase/contracts/providers';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  connectDaemonSocket,
  type SocketInput,
  type SocketOperation,
  type SocketOutput,
} from '@moonbase/pi-runtime/socket';
import { bounded, readJson, startDaemon, temporaryRoot, until } from './fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode } from './faux.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };

test('one WebSocket runs every operation and holds chat, chat-list and provider subscriptions', async () => {
  const root = await temporaryRoot(),
    directory = join(root, 'data');
  const daemon = startDaemon([directory]);
  try {
    const ready = await bounded(daemon.ready);
    const identity = await readJson(join(directory, 'identity.json'));
    const host = identity.host,
      session = { host, actorId: identity.actorId };
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
    const socket = await connectDaemonSocket({
      origin: `http://127.0.0.1:${ready.port}`,
      token,
      expected: host,
    });
    try {
      assert(socket.health.capabilities.includes('socket-v1'));
      const ran = new Set<string>();
      /** One request's reply, or the code it was refused with. */
      const run = async <K extends SocketOperation>(
        operation: K,
        input: SocketInput<K>,
      ): Promise<SocketOutput<K>> => {
        ran.add(operation);
        return socket.request(operation, input);
      };
      const refusal = (promise: Promise<unknown>) =>
        promise.then(
          () => 'ok',
          (error: unknown) => (ApplicationError.is(error) ? error.code : 'thrown'),
        );

      const lists: ChatOutput<'listChats'>[] = [],
        setups: ProviderState[] = [],
        failures: ApplicationError[] = [];
      socket.subscribe('chatList', session, {
        receive: (value) => lists.push(value.list),
        onError: (error) => failures.push(error),
      });
      socket.subscribe(
        'providerSetup',
        { host, ownerId: 'document' },
        { receive: (value) => setups.push(value), onError: (error) => failures.push(error) },
      );

      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, 'readme.md'), 'hello');
      assert.equal(
        (await run('approveFolder', { host, requestId: 'approve', path: project })).path,
        project,
      );
      assert.deepEqual((await run('listRecentFolders', { host })).folders, [project]);
      await run('checkApprovedFolder', { host, path: project });
      assert.equal(await refusal(run('listHostFolders', { host })), 'Incompatible');
      assert.deepEqual((await run('getChatHost', { host })).host, host);
      const created = await run('createChat', {
        session,
        requestId: 'create',
        title: 'Over the socket',
        settings: { cwd: project, model },
      });
      const target = created.conversation.target;
      // The chat list's subscription gains the new row without a read.
      await until(
        async () => lists.at(-1),
        (list) => list?.conversations[0]?.target.conversationId === target.conversationId,
      );
      const chats: ChatSnapshot[] = [];
      socket.subscribe('chat', target, {
        receive: (value) => chats.push(value),
        onError: (error) => failures.push(error),
      });
      assert.deepEqual(
        (await run('findChatFiles', { target, query: 'readme' })).matches.map((m) => m.path),
        ['readme.md'],
      );
      const sent = await run('sendChat', { target, requestId: 'send', text: 'Hello socket' });
      const done = await until(
        async () => chats.at(-1),
        (view) => !!view && !view.run && view.entries.some((entry) => entry.text === 'Faux reply'),
      );
      assert.equal((await run('getChatSend', { target, requestId: 'send' }))?.requestId, 'send');
      const stopped = await run('stopChat', {
        stop: { target, submissionId: sent.submissionId!, taskId: null },
        requestId: 'stop',
      });
      assert.notEqual(stopped.outcome, 'stopped');
      const snapshot = await run('getChat', { target });
      const entry = done!.entries[0]!;
      await run('getChatTranscriptContent', { source: entry.transcript.source });
      await run('findChatTranscript', { target, query: 'Faux' });
      await run('getChatHistoryAround', { target, entryId: entry.id });
      assert.equal(
        await refusal(run('getChatHistory', { target, cursor: 'stale' })),
        'InvalidInput',
      );
      assert.equal(snapshot.conversation.title, 'Over the socket');
      assert.equal(
        (await run('settleChat', { target, settled: true })).settledAt !== undefined,
        true,
      );
      assert.equal((await run('listChats', { session })).conversations.length, 1);
      assert.deepEqual(await run('getActiveWork', { host }), { active: false });
      const own = await run('createChat', {
        session,
        requestId: 'own',
        title: 'Own folder',
        settings: { model },
      });
      await run('checkChatFolder', { host, path: own.conversation.cwd });
      await run('markFolderAsProject', { requestId: 'mark', target: own.conversation.target });

      // ChatGPT sign-in: each change to the flow is pushed, with no polling.
      const owner = { host, ownerId: 'document' };
      assert.equal((await run('getProviders', owner)).state.flow, null);
      const flow = (
        await run('startProviderLogin', { ...owner, requestId: 'start', providerId: 'openai' })
      ).state.flow!;
      const prompt = await until(
        async () => setups.at(-1),
        (state) => !!state?.flow?.canOpenUrl && state.flow.prompt?.type === 'manual_code',
      );
      assert.match((await run('openProviderUrl', { ...owner, flowId: flow.id })).url, /^https:/);
      await run('answerProviderPrompt', {
        ...owner,
        requestId: 'answer',
        flowId: flow.id,
        promptId: prompt!.flow!.prompt!.id,
        answer: fauxSignInCode,
      });
      await until(
        async () => setups.at(-1),
        (state) => state?.flow?.state === 'completed',
      );
      await run('logoutProvider', { ...owner, requestId: 'logout', providerId: 'openai' });
      const again = (
        await run('startProviderLogin', { ...owner, requestId: 'again', providerId: 'openai' })
      ).state.flow!;
      await run('cancelProviderLogin', { ...owner, requestId: 'cancel', flowId: again.id });
      assert.deepEqual(failures, []);
      // Releasing the owner ends its subscription.
      await run('releaseProviderOwner', owner);
      await until(async () => failures.length, Boolean);
      assert.deepEqual(
        (failures as ApplicationError[]).map((error) => error.code),
        ['InvalidInput'],
      );

      assert.deepEqual(
        [...ran].sort(),
        [...Object.keys(chatInputSchemas), ...Object.keys(daemonInputSchemas)].sort(),
      );
    } finally {
      socket.close();
    }
  } finally {
    await daemon.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
