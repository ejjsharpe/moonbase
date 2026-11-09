import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { decodeChatInput, decodeChatOutput, isChatCommand } from '@moonbase/contracts/chat-schema';
import {
  formatChatMention,
  type ChatCommand,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';

const host = { hostId: 'host', storeId: 'store' };
const session = { host, actorId: 'owner' };
const target = { ...session, conversationId: 'chat' };
const stop = { target, submissionId: 'submission', taskId: null };
const conversation = {
  target,
  title: 'Saved chat',
  createdAt: '2026-11-01T00:00:00Z',
  cwd: '/remote/project',
  model: 'configured-model',
};
const snapshot = {
  entries: [{ id: 'entry', role: 'user' as const, text: '', truncated: false }],
  olderCursor: null,
  conversation,
  run: null,
  state: 'idle' as const,
};
const inputs = {
  getChatHost: { host },
  listChats: { session },
  createChat: { session, requestId: 'create', title: '  Saved chat  ' },
  getChat: { target },
  getChatHistory: { target, cursor: 'opaque cursor' },
  getChatTranscriptContent: { source: { kind: 'entry', target, entryId: 'entry' } },
  findChatTranscript: { target, query: '  literal  ' },
  getChatHistoryAround: { target, entryId: 'entry' },
  sendChat: { target, requestId: 'send', text: '  Keep original text  ' },
  getChatSend: { target, requestId: 'send' },
  stopChat: { stop, requestId: 'stop' },
  settleChat: { target, settled: true },
  findChatFiles: { target, query: 'src' },
} satisfies { [K in ChatCommand]: ChatInput<K> };
const outputs = {
  getChatHost: { ...session, cwd: conversation.cwd, model: conversation.model },
  listChats: { conversations: [conversation], nextCursor: null },
  createChat: { requestId: 'create', conversation },
  getChat: snapshot,
  getChatHistory: { entries: snapshot.entries, olderCursor: null },
  getChatTranscriptContent: {
    kind: 'manifest',
    cursor: null,
    source: { kind: 'entry', target, entryId: 'entry' },
    parts: [],
    nextCursor: null,
    thinking: 'none',
  },
  findChatTranscript: {
    target,
    query: '  literal  ',
    cursor: null,
    startCursor: 'start',
    upperEntryId: null,
    matches: [],
    progress: { entries: 0, bytes: 0 },
    nextCursor: null,
  },
  getChatHistoryAround: {
    entries: [],
    olderCursor: null,
    target,
    entryId: 'entry',
    cursor: null,
    newerCursor: null,
    upperEntryId: 'entry',
  },
  sendChat: {
    target,
    requestId: 'send',
    admission: 'admitted' as const,
    submissionId: 'submission',
  },
  getChatSend: null,
  stopChat: { stop, requestId: 'stop', outcome: 'pending' as const },
  settleChat: { ...conversation, settledAt: '2026-11-02T00:00:00Z' },
  findChatFiles: {
    query: 'src',
    matches: [{ path: 'src/a.ts', positions: [0, 1, 2] }],
    partial: false,
  },
} satisfies { [K in ChatCommand]: ChatOutput<K> };

function reverseFields(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseFields(item)]),
  );
}

for (const operation of Object.keys(inputs) as ChatCommand[]) {
  test(`${operation} preserves request/reply values and canonical serialized field order`, () => {
    const request = inputs[operation],
      reply = outputs[operation];
    // Reversed input order must not change persisted request bindings.
    const reversed = reverseFields(request);
    assert.equal(JSON.stringify(decodeChatInput(operation, reversed)), JSON.stringify(request));
    assert.equal(JSON.stringify(decodeChatOutput(operation, reply)), JSON.stringify(reply));
    assert.deepEqual(decodeChatInput(operation, request), request);
  });
  test(`${operation} rejects extra request fields without changing the supplied object`, () => {
    const request = { ...inputs[operation], extra: 'private' };
    assert.throws(() => decodeChatInput(operation, request));
    assert.equal(request.extra, 'private');
  });
}

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

test('page/tool limits, nullable tasks and Send admission combinations keep existing bounds', () => {
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
  const tool = { taskId: 'task', name: 'tool', state: 'running', text: '', truncated: false };
  const run = (count: number) => ({
    ...snapshot,
    run: {
      stop,
      state: 'running',
      text: '',
      truncated: false,
      tools: Array.from({ length: count }, () => tool),
    },
  });
  assert.equal(decodeChatOutput('getChat', run(8)).run!.tools.length, 8);
  assert.throws(() => decodeChatOutput('getChat', run(9)));
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

test('derived public types retain mutable DTO fields and arrays', () => {
  const decoded = decodeChatOutput('getChat', snapshot);
  decoded.state = 'stopped';
  decoded.conversation.title = 'Changed';
  decoded.entries.push({ id: 'next', role: 'assistant', text: 'reply', truncated: false });
  assert.equal(decoded.entries.length, 2);
  assert.equal(snapshot.entries.length, 1);
});

test('schema failures use safe application errors without rejected values', () => {
  const secret = 'synthetic-private-value-not-for-errors';
  for (const [code, decode] of [
    ['InvalidInput', () => decodeChatInput('sendChat', { ...inputs.sendChat, text: { secret } })],
    [
      'Incompatible',
      () => decodeChatOutput('getChatHost', { ...outputs.getChatHost, cwd: { secret } }),
    ],
  ] as const)
    assert.throws(decode, (error: unknown) => {
      assert.equal((error as { code: string }).code, code);
      assert(!String(error).includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      return true;
    });
});

test('schema entry stays independent of application dispatch and privileged implementations', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
    entryPoints: ['@moonbase/contracts/chat-schema'],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((path) =>
      /packages\/(?:application|pi-runtime|ssh|workspace)\/|electron|@earendil-works|node:/.test(
        path,
      ),
    ),
    [],
  );
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
  assert.equal(decodeChatOutput('getChatHost', outputs.getChatHost).features, undefined);
  assert.deepEqual(
    decodeChatOutput('getChatHost', { ...outputs.getChatHost, features: ['transcript-v1'] })
      .features,
    ['transcript-v1'],
  );
  assert.deepEqual(
    decodeChatOutput('getChatHost', {
      ...outputs.getChatHost,
      features: ['transcript-v1', 'future-feature'],
    }).features,
    ['transcript-v1', 'future-feature'],
  );
  assert.equal(isChatCommand('findChatTranscript'), true);
});

test('stream envelopes are strict and bound authority, sequences and decoded fragments', async () => {
  const { decodeChatStreamRequest, decodeChatStreamFrame } =
    await import('@moonbase/contracts/chat-schema');
  const request = { target, connectionId: 'generation' };
  assert.deepEqual(decodeChatStreamRequest(request), request);
  assert.throws(() => decodeChatStreamRequest({ ...request, token: 'private' }));
  const frame = {
    ...request,
    streamId: 'a'.repeat(43),
    sequence: 0,
    kind: 'snapshot',
    offset: 0,
    total: 32768,
    data: Buffer.alloc(32768).toString('base64'),
  };
  assert.deepEqual(decodeChatStreamFrame(frame), frame);
  for (const change of [
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { data: Buffer.alloc(32769).toString('base64') },
    { data: 'bad!' },
    { total: 262145 },
    { extra: true },
    { target: { ...target, path: '/' } },
  ])
    assert.throws(() => decodeChatStreamFrame({ ...frame, ...change }));
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
