import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import {
  chatPageSize,
  chatPreviewBytes,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';
import { decodeChatOutput } from '@moonbase/contracts/chat-schema';
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
/** How a schema-valid reply is refused: decoded first, as one arriving from the wire is. */
const refusalOf = <K extends ChatCommand>(operation: K, output: unknown, input?: ChatInput<K>) => {
  const reply = decodeChatOutput(operation, output);
  const error = Effect.runSync(
    Effect.flip(checkChatOutput(operation, reply, input ?? (inputs[operation] as ChatInput<K>))),
  );
  return { tag: error._tag, reason: 'reason' in error ? error.reason : error.problem };
};
const invalidReply = { tag: 'IncompatibleHostError', reason: 'invalid-reply' };
const other = 'other';
const otherChat = { ...target, conversationId: other };
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
const selection = { partId: 'm0.b0', bytes: 1, revision: 'a'.repeat(64) };
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
    'row from another store': refusalOf('listChats', {
      ...outputs.listChats,
      conversations: [
        { ...conversation, target: { ...target, host: { ...host, storeId: other } } },
      ],
    }),
    'chunk from another store': refusalOf(
      'getChatTranscriptContent',
      {
        kind: 'content',
        cursor: null,
        source: {
          kind: 'entry',
          target: { ...target, host: { ...host, storeId: other } },
          entryId: 'entry',
        },
        selection,
        offset: 0,
        nextCursor: null,
        encoding: 'utf8',
        data: 'x',
      },
      { ...inputs.getChatTranscriptContent, selection },
    ),
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
    'transcript of another chat': refusalOf(
      'getChatHistory',
      historyOf({
        ...entryTranscript('entry'),
        source: { kind: 'entry', target: otherChat, entryId: 'entry' },
      }),
    ),
    'duplicate part': refusalOf(
      'getChatHistory',
      historyOf({ ...entryTranscript('entry'), parts: [part, part] }),
    ),
    'request ID echo': refusalOf('sendChat', { ...outputs.sendChat, requestId: other }),
    'receipt for another chat': refusalOf('sendChat', { ...outputs.sendChat, target: otherChat }),
    'match in another chat': refusalOf('findChatTranscript', {
      ...outputs.findChatTranscript,
      matches: [
        {
          source: { kind: 'entry', target: otherChat, entryId: 'entry' },
          partId: 'm0.b0',
          start: 0,
          end: 1,
          snippet: { start: 0, text: 'x' },
        },
      ],
    }),
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
  // A full history page, each entry's text and transcript part at the preview limit.
  const preview = 'x'.repeat(chatPreviewBytes);
  const entries = Array.from({ length: chatPageSize }, (_, index) => ({
    ...snapshot.entries[0],
    id: `entry-${index}`,
    text: preview,
    transcript: { ...entryTranscript(`entry-${index}`), parts: [{ ...part, text: preview }] },
  }));
  assert.deepEqual(refusalOf('getChatHistory', { entries, olderCursor: null }), {
    tag: 'InvalidChatRequestError',
    reason: 'reply-limit',
  });
});
