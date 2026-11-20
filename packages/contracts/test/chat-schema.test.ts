import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeChatInput, decodeChatOutput, isChatCommand } from '@moonbase/contracts/chat-schema';
import { formatChatMention, type ChatCommand } from '@moonbase/contracts/chat';
import {
  conversation,
  host,
  inputs,
  outputs,
  session,
  snapshot,
  stop,
  target,
} from './chat-fixture.ts';

function reverseFields(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseFields(item)]),
  );
}

test('every command keeps request/reply values in canonical field order and rejects extra request fields', () => {
  for (const operation of Object.keys(inputs) as ChatCommand[]) {
    const request = inputs[operation],
      reply = outputs[operation];
    // Reversed input order must not change persisted request bindings.
    const reversed = reverseFields(request);
    assert.equal(
      JSON.stringify(decodeChatInput(operation, reversed)),
      JSON.stringify(request),
      operation,
    );
    assert.equal(
      JSON.stringify(decodeChatOutput(operation, reply)),
      JSON.stringify(reply),
      operation,
    );
    const extra = { ...request, extra: 'private' };
    assert.throws(() => decodeChatInput(operation, extra), Error, operation);
    assert.equal(extra.extra, 'private');
  }
});

test('request identities are exact and nested unknown fields reject', () => {
  for (const changed of [
    { ...target, extra: 'private' },
    { ...target, host: { ...host, extra: 'private' } },
    { ...target, actorId: '' },
    { ...target, conversationId: 'not an identifier' },
  ])
    assert.throws(() => decodeChatInput('getChat', { target: changed }));
  for (const value of ['constructor', '__proto__', 'unknown', null, 1])
    assert.equal(isChatCommand(value), false);
  assert.equal(isChatCommand('sendChat'), true);
});

test('reply projection strips nested extras and omits undefined optional fields', () => {
  const reply = {
    ...outputs.getChatHost,
    token: 'never public',
    host: { ...host, privateKey: 'never public' },
  };
  assert.deepEqual(decodeChatOutput('getChatHost', reply), outputs.getChatHost);
  assert.equal(reply.token, 'never public');
  assert.deepEqual(decodeChatInput('listChats', { session, cursor: undefined }), { session });
  const entry = {
    ...snapshot.entries[0],
    toolName: undefined,
    isError: undefined,
    extra: 'private',
  };
  assert.deepEqual(
    decodeChatOutput('getChat', {
      ...snapshot,
      entries: [entry],
      message: undefined,
      extra: 'private',
    }),
    snapshot,
  );
});

test('text checks preserve whitespace and count UTF-8 bytes, rejecting invalid Unicode and NUL input', () => {
  const send = (text: unknown) => decodeChatInput('sendChat', { ...inputs.sendChat, text });
  assert.equal(send('😀'.repeat(8192)).text.length, 16384);
  for (const text of ['😀'.repeat(8193), ' ', '\ud800', 'hello\0', 1])
    assert.throws(() => send(text));
  assert.equal(
    decodeChatInput('createChat', { ...inputs.createChat, title: 'é'.repeat(100) }).title.length,
    100,
  );
  assert.throws(() =>
    decodeChatInput('createChat', { ...inputs.createChat, title: 'é'.repeat(101) }),
  );
  // Existing previews allow empty and NUL text, unlike submitted messages.
  for (const text of ['', '\0', '😀'.repeat(1024)]) {
    const reply = { entries: [{ ...snapshot.entries[0], text }], olderCursor: null };
    assert.deepEqual(decodeChatOutput('getChatHistory', reply), reply);
  }
  for (const text of ['😀'.repeat(1025), '\ud800'])
    assert.throws(() =>
      decodeChatOutput('getChatHistory', {
        entries: [{ ...snapshot.entries[0], text }],
        olderCursor: null,
      }),
    );
});

test('page limits, required snapshot fields, nullable tasks and Send admission combinations keep existing bounds', () => {
  const page = (count: number) => ({
    conversations: Array.from({ length: count }, () => conversation),
    nextCursor: null,
  });
  assert.equal(decodeChatOutput('listChats', page(32)).conversations.length, 32);
  assert.throws(() => decodeChatOutput('listChats', page(33)));
  const history = (count: number) => ({
    entries: Array.from({ length: count }, () => snapshot.entries[0]),
    olderCursor: null,
  });
  assert.equal(decodeChatOutput('getChatHistory', history(32)).entries.length, 32);
  assert.throws(() => decodeChatOutput('getChatHistory', history(33)));
  assert.throws(() => decodeChatOutput('getChat', { ...snapshot, state: 'unknown' }));
  const { transcript: _, ...untranscribed } = snapshot.entries[0];
  assert.throws(() => decodeChatOutput('getChat', { ...snapshot, entries: [untranscribed] }));
  const { transcriptBoundary: __, ...unbounded } = snapshot;
  assert.throws(() => decodeChatOutput('getChat', unbounded));
  assert.equal(decodeChatInput('stopChat', inputs.stopChat).stop.taskId, null);
  assert.throws(() =>
    decodeChatInput('stopChat', { ...inputs.stopChat, stop: { ...stop, taskId: undefined } }),
  );
  assert.deepEqual(
    decodeChatOutput('sendChat', {
      ...outputs.sendChat,
      admission: 'reserved',
      submissionId: null,
    }),
    { ...outputs.sendChat, admission: 'reserved', submissionId: null },
  );
  for (const changed of [
    { admission: 'reserved', submissionId: 'task' },
    { admission: 'admitted', submissionId: null },
  ])
    assert.throws(() => decodeChatOutput('sendChat', { ...outputs.sendChat, ...changed }));
});

test("a running response's text parts may carry their whole text within the live budget", () => {
  const source = {
    kind: 'live',
    target,
    submissionId: 'submission',
    taskId: 'task',
    attempt: 0,
    incarnation: 'a'.repeat(64),
  };
  const part = (text: string) => ({
    partId: 'm0.b0',
    bytes: Buffer.byteLength(text),
    revision: 'b'.repeat(64),
    kind: 'text',
    role: 'assistant',
    availability: 'available',
    encoding: 'utf8',
    text,
    truncated: false,
  });
  const transcript = (parts: unknown[]) => ({ source, parts, nextCursor: null, thinking: 'none' });
  const running = (parts: unknown[]) => ({
    ...snapshot,
    run: {
      stop,
      state: 'running',
      text: '',
      truncated: false,
      tools: [],
      transcript: transcript(parts),
    },
  });
  const whole = 'streamed '.repeat(2000);
  assert.equal(
    decodeChatOutput('getChat', running([part(whole)])).run!.transcript!.parts[0]!.text,
    whole,
  );
  // The budget holds across the parts, not per part.
  const half = 'x'.repeat(40 * 1024);
  assert.throws(() => decodeChatOutput('getChat', running([part(half), part(half)])));
  // A stored entry's parts keep their preview bound.
  const entry = {
    id: 'entry',
    role: 'assistant',
    text: '',
    truncated: false,
    transcript: transcript([part(whole)]),
  };
  assert.throws(() => decodeChatOutput('getChat', { ...snapshot, entries: [entry] }));
});

test('schema failures are safe errors without rejected values', () => {
  const secret = 'synthetic-private-value-not-for-errors';
  for (const [tag, decode] of [
    ['SchemaError', () => decodeChatInput('sendChat', { ...inputs.sendChat, text: { secret } })],
    [
      'IncompatibleHostError',
      () => decodeChatOutput('getChatHost', { ...outputs.getChatHost, mode: { secret } }),
    ],
  ] as const)
    assert.throws(decode, (error: unknown) => {
      assert.equal((error as { _tag: string })._tag, tag);
      assert(!String(error).includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      return true;
    });
});

test('transcript schemas bound decoded chunks, canonical base64, identities and continuation evidence', () => {
  const source = { kind: 'entry', target, entryId: 'entry' } as const;
  const selection = { partId: 'm0.b0', bytes: 32768, revision: 'a'.repeat(64) };
  const chunk = {
    kind: 'content',
    cursor: null,
    source,
    selection,
    offset: 0,
    nextCursor: null,
    encoding: 'utf8',
    data: '😀'.repeat(8192),
  };
  assert.deepEqual(decodeChatOutput('getChatTranscriptContent', chunk), chunk);
  for (const changed of [
    { data: '😀'.repeat(8193) },
    { data: '😀'.repeat(8191) },
    { offset: 1 },
    { nextCursor: 'continues' },
    { encoding: 'base64', data: Buffer.alloc(32769).toString('base64') },
    { encoding: 'base64', data: 'not base64!' },
    { data: '\ud800' },
  ])
    assert.throws(() => decodeChatOutput('getChatTranscriptContent', { ...chunk, ...changed }));
  assert.throws(() =>
    decodeChatInput('getChatTranscriptContent', { source: { ...source, path: '/arbitrary' } }),
  );
  assert.throws(() =>
    decodeChatInput('getChatTranscriptContent', { source, selection: { ...selection, bytes: -1 } }),
  );
  assert.equal(isChatCommand('findChatTranscript'), true);
});

test('a snapshot may say it is reconnecting', () => {
  assert.equal(
    decodeChatOutput('getChat', { ...outputs.getChat, observationStatus: 'reconnecting' })
      .observationStatus,
    'reconnecting',
  );
});

test('Find preserves literal whitespace and independently bounds queries and original UTF16 ranges', () => {
  for (const query of [' ', '\r\n', '[.*]', 'Σ𐐀😀'])
    assert.equal(decodeChatInput('findChatTranscript', { target, query }).query, query);
  for (const query of ['', '\0', '\ud800', 'x'.repeat(1025), '😀'.repeat(257)])
    assert.throws(() => decodeChatInput('findChatTranscript', { target, query }));
  const page = {
    ...outputs.findChatTranscript,
    upperEntryId: 'entry',
    matches: [
      {
        source: { kind: 'entry', target, entryId: 'entry' },
        partId: 'm0.b0',
        start: 2,
        end: 4,
        snippet: { start: 0, text: 'a 😀 z' },
      },
    ],
  };
  assert.deepEqual(decodeChatOutput('findChatTranscript', page), page);
  for (const changed of [
    { start: -1 },
    { end: 1 },
    { end: 999 },
    { source: { kind: 'live', target } },
  ])
    assert.throws(() =>
      decodeChatOutput('findChatTranscript', {
        ...page,
        matches: [{ ...page.matches[0], ...changed }],
      }),
    );
});

test('a mention is a relative path spelled in the message text', () => {
  const send = { target, requestId: 'send' };
  assert.equal(formatChatMention('src/a.ts'), '@src/a.ts');
  assert.equal(formatChatMention('docs/My notes.md'), '@"docs/My notes.md"');
  const text = 'Compare @src/a.ts with @"docs/My notes.md"';
  const mentions = [{ path: 'src/a.ts' }, { path: 'docs/My notes.md' }];
  assert.deepEqual(decodeChatInput('sendChat', { ...send, text, mentions }), {
    ...send,
    text,
    mentions,
  });
  for (const path of [
    '',
    '/etc/passwd',
    '../outside',
    'src/../a.ts',
    './a.ts',
    'a//b',
    'a"b',
    'a\\b',
    'a\nb',
  ])
    assert.throws(
      () =>
        decodeChatInput('sendChat', { ...send, text: `@${path} @"${path}"`, mentions: [{ path }] }),
      path,
    );
  // The text alone must still name every mentioned file, and each file is mentioned once.
  assert.throws(() =>
    decodeChatInput('sendChat', { ...send, text: 'No mention', mentions: [{ path: 'src/a.ts' }] }),
  );
  assert.throws(() =>
    decodeChatInput('sendChat', {
      ...send,
      text: '@src/a.ts',
      mentions: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }],
    }),
  );
  assert.throws(() =>
    decodeChatInput('sendChat', {
      ...send,
      text: 'docs/My notes.md',
      mentions: [{ path: 'docs/My notes.md' }],
    }),
  );
  // A mention is a whole token, not the start of a longer path or a word's tail.
  for (const text of ['Open @README.md', 'Open x@README', 'Open @README/a'])
    assert.throws(
      () => decodeChatInput('sendChat', { ...send, text, mentions: [{ path: 'README' }] }),
      text,
    );
  for (const text of ['@README', 'Open @README.', 'Open @README\nnext'])
    assert.doesNotThrow(
      () => decodeChatInput('sendChat', { ...send, text, mentions: [{ path: 'README' }] }),
      text,
    );
  const many = Array.from({ length: 33 }, (_, n) => ({ path: `f${n}` }));
  assert.throws(() =>
    decodeChatInput('sendChat', {
      ...send,
      text: many.map((m) => formatChatMention(m.path)).join(' '),
      mentions: many,
    }),
  );
});

test('file search takes an existing chat or a folder for a new one, and returns mentionable paths', () => {
  assert.deepEqual(decodeChatInput('findChatFiles', { session, cwd: '/work', query: '' }), {
    session,
    cwd: '/work',
    query: '',
  });
  assert.throws(() => decodeChatInput('findChatFiles', { target, cwd: '/work', query: 'a' }));
  assert.throws(() => decodeChatInput('findChatFiles', { target, query: 'x'.repeat(257) }));
  assert.throws(() => decodeChatInput('findChatFiles', { target, query: 'a\0' }));
  assert.throws(() =>
    decodeChatOutput('findChatFiles', {
      query: 'a',
      matches: [{ path: '../a', positions: [] }],
      partial: false,
    }),
  );
  assert.throws(() =>
    decodeChatOutput('findChatFiles', {
      query: 'a',
      matches: Array.from({ length: 51 }, (_, n) => ({ path: `f${n}`, positions: [] })),
      partial: true,
    }),
  );
});
