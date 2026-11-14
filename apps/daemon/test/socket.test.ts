import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatOutput, ChatSnapshot } from '@moonbase/contracts/chat';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import { daemonInputSchemas } from '@moonbase/contracts/daemon-schema';
import type { ProviderState } from '@moonbase/contracts/providers';
import { ApplicationError } from '@moonbase/contracts/errors';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import type { DaemonCommand, DaemonInput, DaemonOutput } from '@moonbase/contracts/daemon';
import { daemonCommandCapabilities, isDaemonMutation } from '@moonbase/contracts/daemon-schema';
import type { ChatCommand, ChatInput } from '@moonbase/contracts/chat';
import { isChatMutation } from '@moonbase/contracts/chat-validation';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import {
  DaemonRpcLink,
  DaemonRpcLinkLive,
  EndpointConnectionLive,
} from '@moonbase/daemon-protocol/remote';
import { bounded, readJson, startDaemon, temporaryRoot, until } from './daemon-fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode } from './faux-provider.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };

test('one RPC connection runs every procedure and holds chat, chat-list and provider watches', async () => {
  const root = await temporaryRoot(),
    directory = join(root, 'data');
  const daemon = startDaemon([directory]);
  try {
    const ready = await bounded(daemon.ready);
    const identity = await readJson(join(directory, 'identity.json'));
    const host = identity.host,
      session = { host, actorId: identity.actorId };
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
    const failures: ApplicationError[] = [];
    const runtime = ManagedRuntime.make(
      DaemonRpcLinkLive({ host }).pipe(
        Layer.provide(
          EndpointConnectionLive({
            origin: `http://127.0.0.1:${ready.port}`,
            token,
            expected: host,
          }),
        ),
      ),
    );
    const subscribe = <K extends 'chat' | 'chatList' | 'providerSetup'>(
      operation: string,
      kind: K,
      payload: object,
      receive: (value: never) => void,
    ) =>
      runtime.runFork(
        Effect.flatMap(DaemonRpcLink, (link) =>
          Stream.runForEach(
            link.watch(operation, kind, payload, {
              capability: chatHostCapabilities.chat,
              kindOfErrors: kind === 'providerSetup' ? 'daemon' : 'chat',
            }),
            (update) => Effect.sync(() => 'value' in update && receive(update.value as never)),
          ),
        ).pipe(Effect.catch((error: ApplicationError) => Effect.sync(() => failures.push(error)))),
      );
    try {
      const ran = new Set<string>();
      /** One request's reply, or the code it was refused with. */
      const run = async <K extends ChatCommand | DaemonCommand>(
        operation: K,
        input: K extends ChatCommand
          ? ChatInput<K>
          : K extends DaemonCommand
            ? DaemonInput<K>
            : never,
      ): Promise<
        K extends ChatCommand ? ChatOutput<K> : K extends DaemonCommand ? DaemonOutput<K> : never
      > => {
        ran.add(operation);
        const daemon = Object.hasOwn(daemonCommandCapabilities, operation);
        return runtime.runPromise(
          Effect.flatMap(DaemonRpcLink, (link) =>
            link.call(
              operation,
              { host, input },
              {
                kind: daemon ? 'daemon' : 'chat',
                mutation: daemon
                  ? isDaemonMutation(operation as DaemonCommand)
                  : isChatMutation(operation as ChatCommand),
                capability: daemon
                  ? daemonCommandCapabilities[operation as DaemonCommand]
                  : chatHostCapabilities.chat,
              },
            ),
          ),
        ) as never;
      };
      const refusal = (promise: Promise<unknown>) =>
        promise.then(
          () => 'ok',
          (error: unknown) => (ApplicationError.is(error) ? error.code : 'thrown'),
        );

      const lists: ChatOutput<'listChats'>[] = [],
        setups: ProviderState[] = [];
      subscribe('watchChatList', 'chatList', { host, session }, (value: { list: never }) =>
        lists.push(value.list),
      );
      subscribe('watchProviderSetup', 'providerSetup', { host, ownerId: 'document' }, (value) =>
        setups.push(value),
      );

      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, 'readme.md'), 'hello');
      // Git lists the folder whether or not this machine has ripgrep on PATH.
      execFileSync('git', ['init', '-q'], { cwd: project });
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
      subscribe('watchChat', 'chat', { host, target }, (value) => chats.push(value));
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
      await runtime.dispose();
    }
  } finally {
    await daemon.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
