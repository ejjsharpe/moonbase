import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import {
  maximumChatReplyBytes,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';
import { checkChatOutput } from '@moonbase/contracts/chat-validation';
import {
  conversation,
  entryTranscript,
  host,
  inputs,
  outputs,
  snapshot,
  stop,
  target,
} from './chat-fixture.ts';

const check = <K extends ChatCommand>(operation: K, output: unknown) =>
  checkChatOutput(operation, output as ChatOutput<K>, inputs[operation] as ChatInput<K>);
const refusalOf = <K extends ChatCommand>(operation: K, output: unknown) => {
  const error = Effect.runSync(Effect.flip(check(operation, output)));
  return { tag: error._tag, reason: 'reason' in error ? error.reason : error.problem };
};
const invalidReply = { tag: 'IncompatibleHostError', reason: 'invalid-reply' };
const other = 'other';
const part = {
  partId: 'm0.b0',
  bytes: 0,
  revision: 'b'.repeat(64),
  kind: 'text',
  role: 'assistant',
  availability: 'available',
  encoding: 'utf8',
  text: '',
  truncated: false,
};
const historyOf = (transcript: unknown) => ({
  entries: [{ ...snapshot.entries[0], transcript }],
  olderCursor: null,
});

test('a reply that answers its request passes unchanged', () => {
  for (const operation of Object.keys(inputs) as ChatCommand[])
    assert.equal(Effect.runSync(check(operation, outputs[operation])), outputs[operation]);
});

test('a reply naming another host, actor, chat or request is refused', () => {
  const refusals = {
    'foreign actor': refusalOf('listChats', {
      ...outputs.listChats,
      conversations: [{ ...conversation, target: { ...target, actorId: other } }],
    }),
    'run for another chat': refusalOf('getChat', {
      ...snapshot,
      run: {
        stop: { ...stop, target: { ...target, conversationId: other } },
        state: 'running',
        text: '',
        truncated: false,
        tools: [],
      },
    }),
    'transcript of another entry': refusalOf('getChatHistory', historyOf(entryTranscript(other))),
    'duplicate part': refusalOf(
      'getChatHistory',
      historyOf({ ...entryTranscript('entry'), parts: [part, part] }),
    ),
    'request ID echo': refusalOf('sendChat', { ...outputs.sendChat, requestId: other }),
    'stop echo': refusalOf('stopChat', { ...outputs.stopChat, stop: { ...stop, taskId: other } }),
    'another host': refusalOf('getChatHost', {
      ...outputs.getChatHost,
      host: { ...host, storeId: other },
    }),
    'query echo': refusalOf('findChatFiles', { ...outputs.findChatFiles, query: other }),
  };
  for (const [check, refusal] of Object.entries(refusals))
    assert.deepEqual(refusal, invalidReply, check);
});

test('a reply over the reply limit is refused', () => {
  assert.deepEqual(
    refusalOf('findChatFiles', {
      ...outputs.findChatFiles,
      matches: [{ path: 'x'.repeat(maximumChatReplyBytes), positions: [] }],
    }),
    { tag: 'InvalidChatRequestError', reason: 'reply-limit' },
  );
});
