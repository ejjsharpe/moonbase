import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, after } from 'node:test';
import { visit } from 'unist-util-visit';
import type { Code } from 'mdast';
import { MarkdownCache } from '../src/renderer/chat/markdown-model.ts';
import { Layer, ManagedRuntime } from 'effect';
import type {
  ChatClient,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { ChatIpcSession } from '../src/chat/session.ts';
import {
  browserClients,
  browserTranscriptActions,
  type ChatBridge,
  type Reply,
} from '../src/chat/wire.ts';
const runtime = ManagedRuntime.make(Layer.empty);
after(() => runtime.dispose());
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
  test(`R2 renderer-selected native Copy: ${name}`, async () => {
    const f = fixture(false, text);
    try {
      const blocks = new MarkdownCache().parse(name, '1', text);
      const code: Code[] = [];
      for (const block of blocks)
        visit(block.tree, 'code', (node) => {
          if (node.data?.codeBlock) code.push(node);
        });
      assert.equal(code.length, 1);
      assert.equal(code[0]!.data?.codeBlock?.index, 0);
      await f.actions.copy({
        source: f.source,
        selection: select(f.part),
        code: { index: code[0]!.data?.codeBlock!.index },
      });
      assert.deepEqual(f.writes, [body]);
    } finally {
      await f.owner.dispose();
    }
  });
  test(`R2 native derives the parser-selected block: ${name}`, async () => {
    const f = fixture(false, text);
    try {
      await f.actions.copy({ source: f.source, selection: select(f.part), code: { index: 0 } });
      assert.deepEqual(f.writes, [body]);
    } finally {
      await f.owner.dispose();
    }
  });
}
test('native validates bounded parser selectors and never accepts renderer code text or ranges', async () => {
  const f = fixture(false, '```js\r\n  🌔\t\r\n```\r\n');
  try {
    for (const code of [
      { index: -1 },
      { index: 0.5 },
      { index: Number.MAX_SAFE_INTEGER + 1 },
      { index: 1 },
      { index: 0, text: 'forged' },
      { index: 0, ranges: [] },
      { start: 0 },
    ]) {
      await assert.rejects(
        f.actions.copy({ source: f.source, selection: select(f.part), code } as never),
        { code: 'InvalidInput' },
      );
      assert.deepEqual(f.writes, []);
    }
  } finally {
    await f.owner.dispose();
  }
});
for (const [name, indented, body] of [
  ['repeated mixed-ending body', 'same', 'same'],
  ['different Unicode/whitespace body', 'other', '🌔 é\t  '],
])
  test(`renderer-selected native Copy skips indented literal fences: ${name}`, async () => {
    const text = `- item\n\n      \`\`\`js\n      ${indented}\n      \`\`\`\n\n  \`\`\`js\r\n  ${body}\r\n  \`\`\`\r\n`;
    const f = fixture(false, text);
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
        code: { index: code.data?.codeBlock.index },
      });
      assert.deepEqual(f.writes, [body]);
      assert.equal(code.data?.codeBlock.index, 0);
    } finally {
      await f.owner.dispose();
    }
  });
test('native parser code Copy preserves meaningful Python indentation in containers and incomplete blocks', async () => {
  for (const prefix of ['> ', '>\t', '- ', '-\t', '- >\t', '> - ']) {
    for (const closed of [false, true]) {
      const continuation = prefix.replace(/-/g, ' ');
      const text = `${prefix}\`\`\`python\r\n${continuation}def moon():\r\n${continuation}    print("🌔 é")\t  \r\n${closed ? continuation + '```\r\n' : ''}`;
      const f = fixture(false, text);
      try {
        await f.actions.copy({ source: f.source, selection: select(f.part), code: { index: 0 } });
        assert.deepEqual(f.writes, ['def moon():\r\n    print("🌔 é")\t  '], prefix);
      } finally {
        await f.owner.dispose();
      }
    }
  }
});
test('normalized live code still requires fixed original source proof across held replies', async () => {
  for (const change of ['append', 'replace', 'source-normalization', 'finalize']) {
    const body = 'def moon():\r\n' + '    print("🌔 é")\t  \r\n'.repeat(5000);
    const f = fixture(true, '```python\r\n' + body);
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
      const copying = f.actions.copy({ source: f.source, selection: selected, code: { index: 0 } });
      if (change === 'append') {
        await copying;
        assert.deepEqual(f.writes, [body.replace(/\r\n$/, '')]);
      } else {
        await assert.rejects(copying);
        assert.deepEqual(f.writes, []);
      }
    } finally {
      await f.owner.dispose();
    }
  }
});
function fixture(live = false, text = '  **raw**\r\n\t🌔 é\r\n' + 'α'.repeat(40000)) {
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
    state: 'running',
    run: {
      stop: { target, submissionId: 'submission', taskId: 'task' },
      state: 'running',
      text: part.text,
      truncated: true,
      tools: [],
      transcript: { source, parts: [part], thinking: 'none', nextCursor: null },
    },
  };
  const controls = {
    beforeRead: async (_read: number) => {},
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
  const chat: ChatClient = {
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
      };
    },
  };
  const owner = new ChatIpcSession(runtime, chat, null, context, () => {}, {
    transcript: {
      writeText: async (value) => {
        await controls.write(value);
        writes.push(value);
      },
      openExternal: async (url) => {
        await controls.open(url);
        links.push(url);
      },
    },
  });
  const bridge: ChatBridge = {
    context: async () => context,
    call: (kind, operation, input, id) => owner.call(kind, operation, input, id),
    cancel: (id) => owner.cancel(id),
    events: () => () => {},
  };
  return {
    owner,
    chat,
    actions: browserTranscriptActions(bridge, 'local'),
    clients: browserClients(bridge, 'local'),
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
  const f = fixture();
  await f.actions.copy({ source: f.source });
  assert.deepEqual(f.writes, [f.original]);
  assert.ok(f.reads > 4);
  await f.owner.dispose();
});
test('native actions retain their captured backend across a held Copy with identical public source identities', async () => {
  const first = fixture(false, 'First backend 🌔\r\n'.repeat(5000)),
    second = fixture(false, 'Different backend content');
  let selected = 'first';
  const held = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  first.controls.beforeRead = async (read) => {
    if (read === 2) {
      started.resolve();
      await held.promise;
    }
  };
  const resolveOwner = (backend = selected) => (backend === 'first' ? first.owner : second.owner);
  const bridge: ChatBridge = {
    context: async () => context,
    call: (kind, operation, input, id, backend) =>
      resolveOwner(backend).call(kind, operation, input, id),
    cancel: (id, backend) => resolveOwner(backend).cancel(id),
    events: () => () => {},
  };
  const actions = browserTranscriptActions(bridge, selected);
  try {
    assert.deepEqual(first.source, second.source);
    const copying = actions.copy({ source: first.source });
    await started.promise;
    selected = 'second';
    held.resolve();
    await copying;
    await actions.openLink('https://example.com/retained-backend');
    assert.deepEqual(first.writes, [first.original]);
    assert.deepEqual(second.writes, []);
    assert.deepEqual(first.links, ['https://example.com/retained-backend']);
    assert.deepEqual(second.links, []);
  } finally {
    held.resolve();
    await Promise.all([first.owner.dispose(), second.owner.dispose()]);
  }
});
test('parser selectors choose the correct repeated/nested block; renderer supplies no text', async () => {
  const f = fixture(
    false,
    '```js\r\nsame\r\n```\r\n\n> ````md\r\n> ```inner\r\n> 🌔\r\n> ```\r\n> ````\r\n\n```js\nsame\n```\n',
  );
  try {
    for (const [index, body] of ['same', '```inner\r\n🌔\r\n```', 'same'].entries()) {
      await f.actions.copy({ source: f.source, selection: select(f.part), code: { index } });
      assert.equal(f.writes.at(-1), body);
    }
    for (const index of [-1, 999, 1.5])
      await assert.rejects(
        f.actions.copy({ source: f.source, selection: select(f.part), code: { index } }),
      );
    assert.equal(f.writes.length, 3);
  } finally {
    await f.owner.dispose();
  }
});
test('live Copy excludes a pure append and obtains fresh fixed-prefix proof before one write', async () => {
  const f = fixture(true);
  const selected = select(f.part);
  f.controls.beforeRead = async (read) => {
    if (read === 2) f.controls.setText(f.original + '\nlate append');
  };
  await f.actions.copy({ source: f.source, selection: selected });
  assert.deepEqual(f.writes, [f.original]);
  assert.ok(f.reads > 5);
  assert.equal(f.closed, 1);
  await f.owner.dispose();
});
test('held content/final proof cannot authorize replacement, rollover, finalization or reconnect', async () => {
  for (const change of ['replace', 'finalize', 'reconnect', 'proof-replace']) {
    const f = fixture(true);
    const selected = select(f.part);
    let changed = false;
    f.controls.beforeRead = async (read) => {
      if (!changed && read === (change === 'proof-replace' ? 7 : 2)) {
        changed = true;
        if (change.endsWith('replace')) f.controls.setText('replacement');
        else if (change === 'finalize') {
          f.controls.snapshot.run = null;
          f.controls.publish();
        } else {
          f.controls.snapshot.observationStatus = 'reconnecting';
          f.controls.publish();
        }
      }
    };
    await assert.rejects(f.actions.copy({ source: f.source, selection: selected }));
    assert.deepEqual(f.writes, []);
    await f.owner.dispose();
  }
});
test('cancel/document replacement fences late code reads and joins actual settlement without blocking other commands', async () => {
  const f = fixture(false, '```js\r\n  🌔\r\n```\r\n');
  const held = Promise.withResolvers<void>();
  let entered = false;
  f.controls.beforeRead = async () => {
    entered = true;
    await held.promise;
  };
  const copy = f.owner.call(
    'transcript',
    'copy',
    { source: f.source, selection: select(f.part), code: { index: 0 } },
    'copy',
  );
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
  let released = false;
  const closing = f.owner.releaseDocument().then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, false);
  held.resolve();
  const result = await copy;
  assert.equal(result.ok, false);
  await closing;
  assert.deepEqual(f.writes, []);
  await f.owner.dispose();
});
test('OS write failure and unsafe links remain observable over the real bridge/session path', async () => {
  const f = fixture(false, '```js\r\n  🌔\r\n```\r\n');
  f.controls.write = async () => {
    throw Error('controlled OS failure');
  };
  await assert.rejects(f.actions.copy({ source: f.source }));
  await assert.rejects(
    f.actions.copy({ source: f.source, selection: select(f.part), code: { index: 0 } }),
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
  const reply: Reply = await f.owner
    .call('transcript', 'copy', { source: foreign }, 'foreign')
    .catch((error) => ({ ok: false, error }));
  assert.equal(reply.ok, false);
  assert.equal(f.links.length, 1);
  await f.owner.dispose();
});

test('native final proof retries superseding appends at most three times without restarting content iteration', async () => {
  for (const appends of [2, 3]) {
    const f = fixture(true);
    const selected = select(f.part);
    let count = 0;
    f.controls.beforeRead = async (read) => {
      if (read >= 7 && count < appends) {
        count++;
        f.controls.setText(f.original + 'later'.repeat(count));
      }
    };
    const copying = f.actions.copy({ source: f.source, selection: selected });
    if (appends === 3) {
      await assert.rejects(copying, { code: 'Conflict' });
      assert.deepEqual(f.writes, []);
    } else {
      await copying;
      assert.deepEqual(f.writes, [f.original]);
    }
    assert.equal(f.reads, 9);
    await f.owner.dispose();
  }
});

test('Copy code is independent of highlight/DOM limits, including a large nested fence', async () => {
  const body = ' 🌔\t  \r\n'.repeat(12000);
  const f = fixture(
    false,
    '> ```unknown\r\n' +
      body
        .split('\r\n')
        .slice(0, -1)
        .map((line) => '> ' + line + '\r\n')
        .join('') +
      '> ```\r\n',
  );
  await f.actions.copy({ source: f.source, selection: select(f.part), code: { index: 0 } });
  assert.deepEqual(f.writes, [body.replace(/\r\n$/, '')]);
  await f.owner.dispose();
});

test('native schema/content echoes and binary content cannot authorize a clipboard write', async () => {
  for (const corruption of ['source', 'selection', 'offset', 'binary']) {
    const f = fixture();
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
    await f.owner.dispose();
  }
  const f = fixture();
  await assert.rejects(
    f.owner.call('transcript', 'copy', { source: f.source, selection: null }, 'malformed'),
  );
  await f.owner.dispose();
});

test('late cancellation joins an already-started async clipboard write and never reports success', async () => {
  const f = fixture();
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.controls.write = async () => {
    entered.resolve();
    await held.promise;
  };
  const copying = f.owner.call('transcript', 'copy', { source: f.source }, 'late-write');
  await entered.promise;
  let settled = false;
  const cancel = f.owner.cancel('late-write').then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  held.resolve();
  const reply = await copying;
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'Cancelled');
  await cancel;
  assert.equal(f.writes.length, 1);
  await f.owner.dispose();
});

test('reentrant cancellation before the first native observation cannot strand Copy', async () => {
  const f = fixture(true);
  let closed = false;
  let cancelled: Promise<Reply> | undefined;
  f.chat.watch = () => {
    cancelled = f.owner.cancel('reentrant');
    return async () => {
      closed = true;
    };
  };
  const reply = await f.owner.call(
    'transcript',
    'copy',
    { source: f.source, selection: select(f.part) },
    'reentrant',
  );
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'Cancelled');
  await cancelled;
  assert.equal(closed, true);
  assert.deepEqual(f.writes, []);
  await f.owner.dispose();
});

test('native Copy validates unfiltered and cross-page manifest identities before writing', async () => {
  for (const acrossPages of [false, true]) {
    const f = fixture(),
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
        if (!acrossPages) reply.parts[1]!.partId = reply.parts[0]!.partId;
        else {
          reply.parts = [reply.parts[0]!];
          reply.cursor = (input as { cursor?: string }).cursor ?? null;
          reply.nextCursor = reply.cursor ? null : 'again';
        }
      }
      return value as never;
    };
    await assert.rejects(f.actions.copy({ source: f.source }), { code: 'Incompatible' });
    assert.deepEqual(f.writes, []);
    await f.owner.dispose();
  }
});

test('native chunk iteration yields to unrelated IPC without another command queue', async () => {
  const f = fixture();
  let readDuringCopy = false;
  const copy = f.actions.copy({ source: f.source });
  const parallel = new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      readDuringCopy = f.writes.length === 0;
      void f.owner.call('chat', 'getChat', { target }, 'parallel').then((reply) => {
        assert.equal(reply.ok, true);
        resolve();
      }, reject);
    }),
  );
  await copy;
  await parallel;
  assert.equal(readDuringCopy, true);
  await f.owner.dispose();
});

test('native link cancellation waits for its actual opener settlement', async () => {
  const f = fixture(),
    entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.controls.open = async () => {
    entered.resolve();
    await held.promise;
  };
  const opening = f.owner.call(
    'transcript',
    'open-link',
    { url: 'https://example.com/read' },
    'held-link',
  );
  await entered.promise;
  let settled = false;
  const cancellation = f.owner.cancel('held-link').then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  held.resolve();
  const reply = await opening;
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'Cancelled');
  await cancellation;
  assert.equal(f.links.length, 1);
  await f.owner.dispose();
});
