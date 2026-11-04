import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, after } from 'node:test';
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
test('source ranges select original whitespace and repeated/nested fences; renderer supplies no text', async () => {
  const f = fixture(false, 'before\r\n```ts\r\n  🌔\t\r\n```\r\nafter');
  const start = f.original.indexOf('```ts');
  await f.actions.copy({ source: f.source, selection: select(f.part), code: { start } });
  assert.deepEqual(f.writes, ['  🌔\t\r\n']);
  for (const start of [-1, 999, f.original.indexOf('🌔') + 1])
    await assert.rejects(
      f.actions.copy({ source: f.source, selection: select(f.part), code: { start } }),
    );
  assert.equal(f.writes.length, 1);
  await f.owner.dispose();
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
test('cancel/document replacement fences late reads and joins actual settlement without blocking other commands', async () => {
  const f = fixture();
  const held = Promise.withResolvers<void>();
  let entered = false;
  f.controls.beforeRead = async () => {
    entered = true;
    await held.promise;
  };
  const copy = f.owner.call('transcript', 'copy', { source: f.source }, 'copy');
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
  const f = fixture();
  f.controls.write = async () => {
    throw Error('controlled OS failure');
  };
  await assert.rejects(f.actions.copy({ source: f.source }));
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

test('Copy code is independent of highlight/DOM/range-count limits, including a large nested fence', async () => {
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
  await f.actions.copy({ source: f.source, selection: select(f.part), code: { start: 0 } });
  assert.deepEqual(f.writes, [body]);
  await f.owner.dispose();
});
