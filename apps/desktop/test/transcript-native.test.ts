import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { visit } from 'unist-util-visit';
import type { Code } from 'mdast';
import { parseTranscriptMarkdown } from '../src/ipc/transcript-markdown.ts';
import { MarkdownCache } from '../src/renderer/chat/transcript/markdown-model.ts';
import { Effect } from 'effect';
import {
  maximumChatReplyBytes,
  type ChatClient,
  type ChatSnapshot,
  type ChatTranscriptPart,
  type ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import {
  maximumTranscriptCodeCopyBytes,
  maximumTranscriptCopyBytes,
  type NativeTranscriptActions,
} from '../src/main/chat/transcript-native.ts';
import { ApplicationError } from '@moonbase/contracts/errors';
import { fakeChatTargets, makeIpcFixture, waitFor } from './fixtures/ipc-fixture.ts';
/** A chat target's fakes: its chat, and the OS clipboard and browser main's Copy and links use. */
type Owner = { chat: ChatClient; transcript: NativeTranscriptActions };
/** Desktop IPC with `local` (and `remote`) as its chat targets, as the renderer reaches them. */
const overIpc = (local: Owner, remote?: Owner) =>
  makeIpcFixture({
    chat: {
      backends: fakeChatTargets({
        local: { chat: local.chat, context },
        ...(remote ? { remote: { chat: remote.chat, context } } : {}),
      }),
      transcript: local.transcript,
    },
  });
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' },
  target = { ...context, conversationId: 'chat' };
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
const select = (part: ChatTranscriptPart) => ({
  partId: part.partId,
  bytes: part.bytes,
  revision: part.revision,
});
for (const [name, text, body] of [
  [
    'unclosed indented literal',
    '- item\n\n      ```js\n      literal\n\n  ```js\r\n  actual 🌔\t  \r\n  ```\r\n',
    'actual 🌔\t  ',
  ],
  ['tabbed list continuation', '- item\n\n\t```js\r\n\t🌔 é\t  \r\n\t```\r\n', '🌔 é\t  '],
  ['tabbed quote', '>\t```js\r\n>\t🌔 é\t  \r\n>\t```\r\n', '🌔 é\t  '],
  ['tab after list marker', '-\t```js\r\n\t🌔 é\t  \r\n\t```\r\n', '🌔 é\t  '],
  ['nested tabbed list', '- item\n\n\t- ```js\r\n\t  🌔 é\t  \r\n\t  ```\r\n', '🌔 é\t  '],
  [
    'list and quote tab columns preserve parser indentation',
    '- >\t```js\r\n  >\t\t🌔 é\t  \r\n  >\t```\r\n',
    '\t🌔 é\t  ',
  ],
] as const) {
  test(`renderer-selected native Copy: ${name}`, async () => {
    const f = await fixture(false, text);
    try {
      const blocks = new MarkdownCache().parse(name, '1', text);
      const code: Code[] = [];
      for (const block of blocks)
        visit(block.tree, 'code', (node) => {
          if (node.data?.codeBlock) code.push(node);
        });
      assert.equal(code.length, 1);
      assert.equal(code[0]!.position!.start.offset, text.lastIndexOf('```js'));
      await f.actions.copy({
        source: f.source,
        selection: select(f.part),
        code: { start: code[0]!.position!.start.offset! },
      });
      assert.deepEqual(f.writes, [body]);
    } finally {
      await f.dispose();
    }
  });
  test(`native derives the parser-selected block: ${name}`, async () => {
    const f = await fixture(false, text);
    try {
      await f.actions.copy({
        source: f.source,
        selection: select(f.part),
        code: { start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset! },
      });
      assert.deepEqual(f.writes, [body]);
    } finally {
      await f.dispose();
    }
  });
}
test('native validates bounded parser selectors and never accepts renderer code text or ranges', async () => {
  const f = await fixture(false, '```js\r\n  🌔\t\r\n```\r\n');
  try {
    for (const code of [
      { start: -1 },
      { start: 0.5 },
      { start: Number.MAX_SAFE_INTEGER + 1 },
      { start: f.part.bytes },
      { start: 0, text: 'forged' },
      { start: 0, ranges: [] },
      { index: 0 },
      { start: 0, index: 0 },
    ]) {
      const reply = await f.desktop.call('copyTranscript', {
        backendId: 'local',
        copy: { source: f.source, selection: select(f.part), code },
      });
      assert.equal(reply.error?._tag, 'Die', JSON.stringify(code));
      assert.deepEqual(f.writes, []);
    }
  } finally {
    await f.dispose();
  }
});
for (const [name, indented, body] of [
  ['repeated mixed-ending body', 'same', 'same'],
  ['different Unicode/whitespace body', 'other', '🌔 é\t  '],
])
  test(`renderer-selected native Copy skips indented literal fences: ${name}`, async () => {
    const text = `- item\n\n      \`\`\`js\n      ${indented}\n      \`\`\`\n\n  \`\`\`js\r\n  ${body}\r\n  \`\`\`\r\n`;
    const f = await fixture(false, text);
    try {
      const blocks = new MarkdownCache().parse('mixed', '1', text);
      let code: Code | undefined;
      for (const block of blocks)
        visit(block.tree, 'code', (node) => {
          if (node.data?.codeBlock) code = node;
        });
      assert.ok(code?.data?.codeBlock, 'the real fenced block retains Copy');
      await f.actions.copy({
        source: f.source,
        selection: select(f.part),
        code: { start: code.position!.start.offset! },
      });
      assert.deepEqual(f.writes, [body]);
      assert.equal(code.position!.start.offset, text.lastIndexOf('```js'));
    } finally {
      await f.dispose();
    }
  });
test('native parser code Copy preserves meaningful Python indentation in containers and incomplete blocks', async () => {
  for (const prefix of ['> ', '>\t', '- ', '-\t', '- >\t', '> - ']) {
    for (const closed of [false, true]) {
      const continuation = prefix.replace(/-/g, ' ');
      const text = `${prefix}\`\`\`python\r\n${continuation}def moon():\r\n${continuation}    print("🌔 é")\t  \r\n${closed ? continuation + '```\r\n' : ''}`;
      const f = await fixture(false, text);
      try {
        await f.actions.copy({
          source: f.source,
          selection: select(f.part),
          code: {
            start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset!,
          },
        });
        assert.deepEqual(f.writes, ['def moon():\r\n    print("🌔 é")\t  '], prefix);
      } finally {
        await f.dispose();
      }
    }
  }
});
test('normalized live code still requires fixed original source proof across held replies', async () => {
  for (const change of ['append', 'replace', 'source-normalization', 'finalize']) {
    const body = 'def moon():\r\n' + '    print("🌔 é")\t  \r\n'.repeat(5000);
    const f = await fixture(true, '```python\r\n' + body);
    try {
      const selected = select(f.part);
      f.controls.beforeRead = async (read) => {
        if (read !== 2) return;
        if (change === 'append') f.controls.setText(f.original + '\r\n```\r\nlater');
        else if (change === 'replace') f.controls.setText('replacement');
        else if (change === 'source-normalization')
          f.controls.setText(f.original.replace(/\r\n/g, '\n'));
        else {
          f.controls.snapshot.run = null;
          f.controls.publish();
        }
      };
      const copying = f.actions.copy({
        source: f.source,
        selection: selected,
        code: { start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset! },
      });
      if (change === 'append') {
        await copying;
        assert.deepEqual(f.writes, [body.replace(/\r\n$/, '')]);
      } else {
        await assert.rejects(copying);
        assert.deepEqual(f.writes, []);
      }
    } finally {
      await f.dispose();
    }
  }
});
async function fixture(live = false, text = '  **raw**\r\n\t🌔 é\r\n' + 'α'.repeat(40000)) {
  const original = text;
  const source: ChatTranscriptSource = live
    ? {
        kind: 'live',
        target,
        submissionId: 'submission',
        taskId: 'task',
        attempt: 0,
        incarnation: 'a'.repeat(64),
      }
    : { kind: 'entry', target, entryId: 'entry' };
  const part: ChatTranscriptPart = {
    partId: 'm0.b0',
    bytes: Buffer.byteLength(text),
    revision: revision(text),
    kind: 'text',
    role: 'assistant',
    availability: 'available',
    encoding: 'utf8',
    text: text.slice(0, 40),
    truncated: true,
  };
  const writes: string[] = [],
    links: string[] = [];
  let receive: ((snapshot: ChatSnapshot) => void) | undefined,
    closed = 0,
    reads = 0;
  const snapshot: ChatSnapshot = {
    conversation: {
      target,
      title: 'test',
      cwd: '/',
      model: 'fixture',
      createdAt: '2026-01-01T00:00:00Z',
    },
    entries: [],
    olderCursor: null,
    transcriptBoundary: null,
    state: 'running',
    run: {
      stop: { target, submissionId: 'submission', taskId: 'task' },
      state: 'running',
      text: part.text,
      truncated: true,
      transcript: { source, parts: [part], thinking: 'none', nextCursor: null },
    },
  };
  const controls = {
    beforeRead: async (_read: number) => {},
    close: async () => {},
    write: async (_text: string) => {},
    open: async (_url: string) => {},
    snapshot,
    setText(value: string) {
      text = value;
      part.bytes = Buffer.byteLength(value);
      part.revision = revision(value);
      receive?.(structuredClone(snapshot));
    },
    publish() {
      receive?.(structuredClone(snapshot));
    },
  };
  // Trusted ChatClient: it stands in for a boundary that already decoded and bounded replies.
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    async command(operation, input) {
      if (operation === 'getChat') return structuredClone(snapshot) as never;
      assert.equal(operation, 'getChatTranscriptContent');
      const request = input as {
        source: ChatTranscriptSource;
        selection?: { partId: string; bytes: number; revision: string };
        cursor?: string;
      };
      reads++;
      // Capture a reply before the controllable transport hold, as a real old response may be held.
      let reply;
      if (!request.selection)
        reply = {
          kind: 'manifest',
          source,
          cursor: null,
          parts: [part, { ...part, partId: 'thinking', kind: 'thinking', text: 'private thought' }],
          thinking: 'available',
          nextCursor: null,
        };
      else {
        assert.equal(request.selection.partId, 'm0.b0');
        const bytes = Buffer.from(text).subarray(0, request.selection.bytes);
        if (revision(bytes.toString()) !== request.selection.revision)
          throw Object.assign(Error('Source changed'), { code: 'Conflict' });
        const offset = Number(request.cursor ?? 0);
        let end = Math.min(offset + 16000, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        reply = {
          kind: 'content',
          source,
          selection: request.selection,
          cursor: request.cursor ?? null,
          offset,
          encoding: 'utf8',
          data: bytes.subarray(offset, end).toString(),
          nextCursor: end < bytes.length ? String(end) : null,
        };
      }
      const captured = structuredClone(reply);
      await controls.beforeRead(reads);
      return captured as never;
    },
    watch(_input, callback) {
      receive = callback;
      callback(structuredClone(snapshot));
      return async () => {
        closed++;
        receive = undefined;
        await controls.close();
      };
    },
  };
  const owner: Owner = {
    chat,
    transcript: {
      writeText: async (value: string) => {
        await controls.write(value);
        writes.push(value);
      },
      openExternal: async (url: string) => {
        await controls.open(url);
        links.push(url);
      },
    },
  };
  const desktop = await overIpc(owner);
  return {
    owner,
    chat,
    desktop,
    actions: desktop.target('local').transcript,
    ports: await desktop.ports('local'),
    dispose: () => desktop.dispose(),
    source,
    part,
    original,
    controls,
    writes,
    links,
    get reads() {
      return reads;
    },
    get closed() {
      return closed;
    },
  };
}
test('native Copy reads complete authored Markdown beyond previews with exact Unicode/CRLF, excluding thinking', async () => {
  const f = await fixture();
  await f.actions.copy({ source: f.source });
  assert.deepEqual(f.writes, [f.original]);
  assert.ok(f.reads > 4);
  await f.dispose();
});
test('native Copy reads the target it was asked for, whichever is selected later', async () => {
  const first = await fixture(false, 'First backend 🌔\r\n'.repeat(5000)),
    second = await fixture(false, 'Different backend content');
  const desktop = await overIpc(first.owner, second.owner);
  try {
    assert.deepEqual(first.source, second.source);
    await desktop.target('local').transcript.copy({ source: first.source });
    await desktop.target('local').transcript.openLink('https://example.com/retained-backend');
    assert.deepEqual(first.writes, [first.original]);
    assert.equal(second.reads, 0);
    assert.deepEqual(first.links, ['https://example.com/retained-backend']);
  } finally {
    await desktop.dispose();
    await Promise.all([first.dispose(), second.dispose()]);
  }
});
test('parser selectors choose the correct repeated/nested block; renderer supplies no text', async () => {
  const f = await fixture(
    false,
    '```js\r\nsame\r\n```\r\n\n> ````md\r\n> ```inner\r\n> 🌔\r\n> ```\r\n> ````\r\n\n```js\nsame\n```\n',
  );
  try {
    for (const [index, body] of ['same', '```inner\r\n🌔\r\n```', 'same'].entries()) {
      await f.actions.copy({
        source: f.source,
        selection: select(f.part),
        code: {
          start: parseTranscriptMarkdown(f.original).codeBlocks[index]!.position!.start.offset!,
        },
      });
      assert.equal(f.writes.at(-1), body);
    }
    for (const start of [-1, 999, 1.5])
      await assert.rejects(
        f.actions.copy({ source: f.source, selection: select(f.part), code: { start } }),
      );
    assert.equal(f.writes.length, 3);
  } finally {
    await f.dispose();
  }
});
test('live Copy excludes a pure append and obtains fresh fixed-prefix proof before one write', async () => {
  const f = await fixture(true);
  const selected = select(f.part);
  f.controls.beforeRead = async (read) => {
    if (read === 2) f.controls.setText(f.original + '\nlate append');
  };
  await f.actions.copy({ source: f.source, selection: selected });
  assert.deepEqual(f.writes, [f.original]);
  assert.ok(f.reads > 5);
  assert.equal(f.closed, 1);
  await f.dispose();
});
test('held content/final proof cannot authorize replacement, rollover, finalization or reconnect', async () => {
  for (const change of ['replace', 'finalize', 'reconnect', 'proof-finalize', 'proof-reconnect']) {
    const f = await fixture(true);
    const selected = select(f.part);
    let changed = false;
    f.controls.beforeRead = async (read) => {
      if (!changed && read === (change.startsWith('proof-') ? 7 : 2)) {
        changed = true;
        if (change.endsWith('replace')) f.controls.setText('replacement');
        else if (change.endsWith('finalize')) {
          f.controls.snapshot.run = null;
          f.controls.publish();
        } else {
          f.controls.snapshot.observationStatus = 'reconnecting';
          f.controls.publish();
        }
      }
    };
    // The host refuses a replaced prefix on the next read; main refuses observed source changes.
    await assert.rejects(
      f.actions.copy({ source: f.source, selection: selected }),
      change === 'replace' ? ApplicationError : { code: 'Conflict' },
    );
    assert.deepEqual(f.writes, []);
    await f.dispose();
  }
});
test('a replacement after the host answers the proof copies the proven prefix', async () => {
  const f = await fixture(true);
  f.controls.beforeRead = async (read) => {
    // The proof reply was computed from the original prefix before this replacement.
    if (read === 7) f.controls.setText('replacement');
  };
  await f.actions.copy({ source: f.source, selection: select(f.part) });
  assert.deepEqual(f.writes, [f.original]);
  assert.equal(f.reads, 7);
  await f.dispose();
});
test('a replaced document ends a held code read, which then writes nothing', async () => {
  const f = await fixture(false, '```js\r\n  🌔\r\n```\r\n');
  const held = Promise.withResolvers<void>();
  let entered = false;
  f.controls.beforeRead = async () => {
    entered = true;
    await held.promise;
  };
  const copy = f.actions.copy({
    source: f.source,
    selection: select(f.part),
    code: { start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset! },
  });
  void copy.catch(() => {});
  await waitFor(() => entered);
  await f.desktop.releaseDocument();
  await assert.rejects(copy);
  held.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.writes, []);
  await f.dispose();
});
test('OS write failure and unsafe links remain observable over the real bridge/session path', async () => {
  const f = await fixture(false, '```js\r\n  🌔\r\n```\r\n');
  f.controls.write = async () => {
    throw Error('controlled OS failure');
  };
  await assert.rejects(f.actions.copy({ source: f.source }));
  await assert.rejects(
    f.actions.copy({
      source: f.source,
      selection: select(f.part),
      code: { start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset! },
    }),
  );
  assert.deepEqual(f.writes, []);
  await f.actions.openLink('https://example.com/read?q=1');
  assert.deepEqual(f.links, ['https://example.com/read?q=1']);
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/file',
    'data:text/html,hi',
    '//example.com',
    'https://user:secret@example.com',
    'https://example.com/\n',
  ])
    await assert.rejects(f.actions.openLink(url));
  const foreign = structuredClone(f.source);
  foreign.target.host.storeId = 'other';
  assert.deepEqual(
    await f.desktop.call('copyTranscript', { backendId: 'local', copy: { source: foreign } }),
    {
      ok: false,
      error: { _tag: 'IpcAuthorityError', refusal: 'host' },
    },
  );
  assert.equal(f.links.length, 1);
  await f.dispose();
});

test('streaming appends during every content and proof read keep the copied prefix', async () => {
  const f = await fixture(true);
  const selected = select(f.part);
  let appended = '';
  f.controls.beforeRead = async () => {
    appended += 'later';
    f.controls.setText(f.original + appended);
  };
  await f.actions.copy({ source: f.source, selection: selected });
  assert.deepEqual(f.writes, [f.original]);
  assert.equal(f.reads, 7, 'one proof read, never restarted');
  await f.dispose();
});
test('a live rewrite that keeps growing is still refused by the fixed-prefix proof', async () => {
  const f = await fixture(true);
  f.controls.beforeRead = async (read) => {
    // The last content reply was captured first; the proof then reads the rewritten source.
    if (read === 6) f.controls.setText('rewritten '.repeat(f.original.length));
  };
  // The host refuses the changed prefix.
  await assert.rejects(f.actions.copy({ source: f.source, selection: select(f.part) }));
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads, 7);
  await f.dispose();
});

test('Copy code is independent of highlight/DOM limits, including a large nested fence', async () => {
  const body = ' 🌔\t  \r\n'.repeat(12000);
  const f = await fixture(
    false,
    '> ```unknown\r\n' +
      body
        .split('\r\n')
        .slice(0, -1)
        .map((line) => '> ' + line + '\r\n')
        .join('') +
      '> ```\r\n',
  );
  await f.actions.copy({
    source: f.source,
    selection: select(f.part),
    code: { start: parseTranscriptMarkdown(f.original).codeBlocks[0]!.position!.start.offset! },
  });
  assert.deepEqual(f.writes, [body.replace(/\r\n$/, '')]);
  await f.dispose();
});

test('native Copy trusts main ChatClient replies and snapshots without decoding them again', async () => {
  const f = await fixture(true);
  const padding = 'x'.repeat(maximumChatReplyBytes);
  const { command, watch } = f.chat;
  f.chat.command = async (operation, input, options) =>
    ({ ...(await command(operation, input, options)), padding }) as never;
  f.chat.watch = (input, receive, onError) =>
    watch(input, (snapshot) => receive({ ...snapshot, padding } as ChatSnapshot), onError);
  await f.actions.copy({ source: f.source });
  assert.deepEqual(f.writes, [f.original]);
  await f.dispose();
});
test('native schema/content echoes and binary content cannot authorize a clipboard write', async () => {
  for (const corruption of ['source', 'selection', 'offset', 'binary']) {
    const f = await fixture();
    const command = f.chat.command;
    f.chat.command = async (operation, input, options) => {
      const value = await command(operation, input, options);
      if (operation !== 'getChatTranscriptContent') return value as never;
      const reply = value as {
        kind: string;
        source: { target: { actorId: string } };
        selection?: { revision: string };
        offset?: number;
        encoding?: string;
        data?: string;
      };
      if (reply.kind === 'content') {
        if (corruption === 'source') reply.source.target.actorId = 'foreign';
        if (corruption === 'selection') reply.selection!.revision = 'b'.repeat(64);
        if (corruption === 'offset') reply.offset = 1;
        if (corruption === 'binary') {
          reply.encoding = 'base64';
          reply.data = Buffer.from(reply.data!).toString('base64');
        }
      }
      return value as never;
    };
    await assert.rejects(f.actions.copy({ source: f.source, selection: select(f.part) }));
    assert.deepEqual(f.writes, []);
    await f.dispose();
  }
  const f = await fixture();
  const malformed = await f.desktop.call('copyTranscript', {
    backendId: 'local',
    copy: { source: f.source, selection: null },
  });
  assert.equal(malformed.error?._tag, 'Die');
  await f.dispose();
});

test('a cancelled Copy never reports success, and its document waits for the clipboard write', async () => {
  const f = await fixture();
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.controls.write = async () => {
    entered.resolve();
    await held.promise;
  };
  const abort = new AbortController();
  const copying = f.actions.copy({ source: f.source }, abort.signal);
  await entered.promise;
  abort.abort();
  await assert.rejects(copying, { code: 'Cancelled' });
  let released = false;
  const closing = f.desktop.releaseDocument().then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(released, false);
  held.resolve();
  await closing;
  assert.equal(f.writes.length, 1);
  await f.dispose();
});
// Unfiltered duplicates are rejected at the ChatClient boundary (chat-runtime transport test).
test('native Copy rejects repeated copied parts within and across manifest pages before writing', async () => {
  for (const acrossPages of [false, true]) {
    const f = await fixture(),
      command = f.chat.command;
    f.chat.command = async (operation, input, options) => {
      const value = await command(operation, input, options);
      if (
        operation === 'getChatTranscriptContent' &&
        !(input as { selection?: unknown }).selection
      ) {
        const reply = value as {
          parts: ChatTranscriptPart[];
          cursor: string | null;
          nextCursor: string | null;
        };
        if (!acrossPages) reply.parts[1] = { ...reply.parts[0]! };
        else {
          reply.parts = [reply.parts[0]!];
          reply.cursor = (input as { cursor?: string }).cursor ?? null;
          reply.nextCursor = reply.cursor ? null : 'again';
        }
      }
      return value as never;
    };
    await assert.rejects(f.actions.copy({ source: f.source }), {
      code: 'Incompatible',
      message: acrossPages
        ? 'Transcript manifest repeats a selected part.'
        : 'Transcript manifest repeats a part.',
    });
    assert.deepEqual(f.writes, []);
    await f.dispose();
  }
});

test('native chunk iteration yields to unrelated IPC without another command queue', async () => {
  const f = await fixture();
  let readDuringCopy = false;
  const copy = f.actions.copy({ source: f.source });
  const parallel = new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      readDuringCopy = f.writes.length === 0;
      void Effect.runPromise(f.ports.chat.getChat({ target })).then(() => resolve(), reject);
    }),
  );
  await copy;
  await parallel;
  assert.equal(readDuringCopy, true);
  await f.dispose();
});

test('a cancelled link waits in its document for the opener to settle', async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.controls.open = async () => {
    entered.resolve();
    await held.promise;
  };
  const abort = new AbortController();
  const opening = f.actions.openLink('https://example.com/read', abort.signal);
  await entered.promise;
  abort.abort();
  await assert.rejects(opening, { code: 'Cancelled' });
  let released = false;
  const closing = f.desktop.releaseDocument().then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(released, false);
  held.resolve();
  await closing;
  assert.equal(f.links.length, 1);
  await f.dispose();
});
test('native rejects a partial parser node reinterpreted as another block in the full source', async () => {
  const prefix = 'x'.repeat(15993) + '\n\n```js';
  const full = prefix + '`invalid\n\n```python\nWRONG BLOCK\n```\n';
  const f = await fixture(false, full);
  try {
    const partial = parseTranscriptMarkdown(prefix).codeBlocks[0]!;
    assert.equal(partial.value, '');
    const start = partial.position!.start.offset!;
    assert.equal(start, 15995);
    await assert.rejects(
      f.actions.copy({ source: f.source, selection: select(f.part), code: { start } }),
      { code: 'Conflict' },
    );
    assert.deepEqual(f.writes, []);
    await f.actions.copy({
      source: f.source,
      selection: select(f.part),
      code: { start: full.indexOf('```python') },
    });
    assert.deepEqual(f.writes, ['WRONG BLOCK']);
    await f.actions.copy({ source: f.source });
    assert.equal(f.writes.at(-1), full);
  } finally {
    await f.dispose();
  }
});

test('a replaced document ends a held live read and closes its watch', async () => {
  const f = await fixture(true, 'complete text');
  const readGate = Promise.withResolvers<void>(),
    readEntered = Promise.withResolvers<void>();
  f.controls.beforeRead = async () => {
    readEntered.resolve();
    await readGate.promise;
  };
  const copying = f.actions.copy({ source: f.source, selection: select(f.part) });
  void copying.catch(() => {});
  try {
    await readEntered.promise;
    await f.desktop.releaseDocument();
    await assert.rejects(copying);
    readGate.resolve();
    await new Promise(setImmediate);
    assert.deepEqual(f.writes, []);
    assert.equal(f.closed, 1);
  } finally {
    readGate.resolve();
    await f.dispose();
  }
});

test('Copy accepts an empty authored text part', async () => {
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: 'entry' };
  const empty: ChatTranscriptPart = {
    partId: 'm0.b0',
    bytes: 0,
    revision: revision(''),
    kind: 'text',
    role: 'assistant',
    availability: 'available',
    encoding: 'utf8',
    text: '',
    truncated: false,
  };
  const writes: string[] = [];
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    async command(_operation, input) {
      const { selection } = input as { selection?: object };
      return (
        selection
          ? {
              kind: 'content',
              source,
              selection: select(empty),
              cursor: null,
              offset: 0,
              encoding: 'utf8',
              data: '',
              nextCursor: null,
            }
          : {
              kind: 'manifest',
              source,
              cursor: null,
              parts: [empty],
              thinking: 'none',
              nextCursor: null,
            }
      ) as never;
    },
    watch: () => () => Promise.resolve(),
  };
  const desktop = await overIpc({
    chat,
    transcript: {
      writeText: async (text: string) => {
        writes.push(text);
      },
      openExternal: async () => {},
    },
  });
  await desktop.target('local').transcript.copy({ source });
  assert.deepEqual(writes, ['']);
  await desktop.dispose();
});

/** An entry with several authored text parts, served in fixed-size chunks. */
async function partsFixture(texts: string[], chunkBytes = 4) {
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: 'entry' };
  const parts = texts.map((text, index): ChatTranscriptPart => ({
    partId: `m0.b${index}`,
    bytes: Buffer.byteLength(text),
    revision: revision(text),
    kind: 'text',
    role: index % 2 ? 'user' : 'assistant',
    availability: 'available',
    encoding: 'utf8',
    text: text.slice(0, 40),
    truncated: text.length > 40,
  }));
  const reads: string[] = [],
    writes: string[] = [];
  const chat: ChatClient = {
    watchChatList: () => async () => {},
    async command(_operation, input) {
      const { selection, cursor } = input as { selection?: { partId: string }; cursor?: string };
      if (!selection)
        return {
          kind: 'manifest',
          source,
          cursor: null,
          parts: [...parts, { ...parts[0]!, partId: 'thinking', kind: 'thinking' }],
          thinking: 'available',
          nextCursor: null,
        } as never;
      reads.push(selection.partId);
      const index = parts.findIndex((part) => part.partId === selection.partId);
      const bytes = Buffer.from(texts[index]!),
        offset = Number(cursor ?? 0),
        end = Math.min(offset + chunkBytes, bytes.length);
      return {
        kind: 'content',
        source,
        selection: select(parts[index]!),
        cursor: cursor ?? null,
        offset,
        encoding: 'utf8',
        data: bytes.subarray(offset, end).toString(),
        nextCursor: end < bytes.length ? String(end) : null,
      } as never;
    },
    watch: () => () => Promise.resolve(),
  };
  const desktop = await overIpc({
    chat,
    transcript: {
      writeText: async (text: string) => {
        writes.push(text);
      },
      openExternal: async () => {},
    },
  });
  return {
    source,
    parts,
    reads,
    writes,
    copy: (input: object = {}) => desktop.target('local').transcript.copy({ source, ...input }),
    dispose: () => desktop.dispose(),
  };
}

test('whole-message Copy separates authored text parts while chunks of one part stay joined', async () => {
  const f = await partsFixture(['First part', 'Second part 🌔']);
  try {
    await f.copy();
    assert.deepEqual(f.writes, ['First part\n\nSecond part 🌔']);
    assert(f.reads.length > 2, 'parts arrive in several chunks');
    await f.copy({ selection: select(f.parts[1]!) });
    assert.equal(f.writes.at(-1), 'Second part 🌔');
  } finally {
    await f.dispose();
  }
});

test('Copy refuses more than its byte limit as soon as a part would exceed it', async () => {
  const mib = 1024 * 1024;
  const f = await partsFixture(
    ['a'.repeat(3 * mib), 'b'.repeat(3 * mib), 'c'.repeat(3 * mib)],
    mib,
  );
  try {
    await assert.rejects(f.copy(), { code: 'Unavailable', message: /8 MiB/ });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(
      f.reads.filter((partId) => partId === 'm0.b2'),
      ['m0.b2'],
      'the over-limit part is not buffered',
    );
    const over = { ...select(f.parts[0]!), bytes: maximumTranscriptCopyBytes + 1 };
    const reads = f.reads.length;
    await assert.rejects(f.copy({ selection: over }), { code: 'Unavailable', message: /8 MiB/ });
    assert.equal(f.reads.length, reads, 'an over-limit selection is refused before reading');
    assert.deepEqual(f.writes, []);
  } finally {
    await f.dispose();
  }
});

test('Copy accepts exactly its byte limit including part separators', async () => {
  const mib = 1024 * 1024;
  const first = 'a'.repeat(4 * mib),
    second = 'b'.repeat(maximumTranscriptCopyBytes - first.length - 2);
  const exact = await partsFixture([first, second], mib);
  try {
    await exact.copy();
    assert.equal(exact.writes[0]!.length, maximumTranscriptCopyBytes);
  } finally {
    await exact.dispose();
  }
  const over = await partsFixture([first, second + 'b'], mib);
  try {
    await assert.rejects(over.copy(), { code: 'Unavailable', message: /8 MiB/ });
    assert.deepEqual(over.writes, []);
  } finally {
    await over.dispose();
  }
});

test('link opening pins URL normalisation of slashless and uppercase forms', async () => {
  const f = await fixture();
  try {
    await f.actions.openLink('https:example.com');
    await f.actions.openLink('HTTPS://Example.com/a%20b');
    assert.deepEqual(f.links, ['https://example.com/', 'https://example.com/a%20b']);
  } finally {
    await f.dispose();
  }
});

test('code Copy refuses parts too large to parse on main without reading them', async () => {
  const text = '```js\nmoon\n```\n' + 'x'.repeat(maximumTranscriptCodeCopyBytes);
  const f = await partsFixture([text], 64 * 1024);
  try {
    await assert.rejects(f.copy({ selection: select(f.parts[0]!), code: { start: 0 } }), {
      code: 'Unavailable',
      message: /1 MiB/,
    });
    assert.deepEqual(f.reads, []);
    await f.copy({ selection: select(f.parts[0]!) });
    assert.deepEqual(f.writes, [text], 'the whole part still copies');
  } finally {
    await f.dispose();
  }
});

test('a third concurrent Copy is refused as busy, not invalid', async () => {
  const f = await fixture();
  const held = Promise.withResolvers<void>();
  let entered = 0;
  f.controls.beforeRead = async () => {
    entered++;
    await held.promise;
  };
  try {
    const copies = [0, 1].map(() => f.actions.copy({ source: f.source }));
    await waitFor(() => entered === 2);
    await assert.rejects(f.actions.copy({ source: f.source }), {
      code: 'Unavailable',
      message: /Another Copy is in progress/,
    });
    held.resolve();
    await Promise.all(copies);
    assert.deepEqual(f.writes, [f.original, f.original]);
  } finally {
    held.resolve();
    await f.dispose();
  }
});
