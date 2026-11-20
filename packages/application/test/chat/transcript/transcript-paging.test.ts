import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatInput } from '@moonbase/contracts/chat';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { digest, part, tick, transcriptHarness, until } from './transcript-fixture.ts';

test('a snapshot with no room for entries continues history from its older cursor', async (t) => {
  const f = await transcriptHarness(t, 200);
  const cursors: string[] = [];
  f.handlers.set('getChatHistory', async (raw) => {
    const { cursor } = raw as ChatInput<'getChatHistory'>;
    cursors.push(cursor);
    const end = Number(cursor),
      start = Math.max(0, end - 32);
    return {
      entries: f.entries.slice(start, end).reverse(),
      olderCursor: start ? String(start) : null,
    };
  });
  // A live run can leave a snapshot no room for entries, but not for its older cursor.
  f.snapshot = { ...f.snapshot, entries: [], olderCursor: '200' };
  await f.reopen();
  assert.equal(f.state.earlier, true);
  await f.transcript.showEarlier();
  assert.deepEqual(cursors, ['200']);
  let state = f.state;
  assert.equal(state.error, null);
  assert.equal(state.entries.length, 32);
  assert.equal(state.entries[0].id, 'e168');
  // Further history is read around the retained records.
  await f.transcript.showEarlier();
  state = f.state;
  assert.deepEqual(cursors, ['200']);
  assert.equal(state.error, null);
  assert(state.entries.length > 32);
  assert.equal(state.entries.at(-1)!.id, 'e199');
});

test('every accepted snapshot change publishes once, with the snapshot', async (t) => {
  const f = await transcriptHarness(t, 40);
  const publications = f.publications;
  // A subscriber sees each publication after the change that made it.
  const published = (count: number) => until(() => f.publications === publications + count);
  await f.publish({ ...f.snapshot, state: 'running' });
  await published(1);
  assert.equal(f.published!.state, 'running');
  const entry = {
    ...f.entries[0],
    id: 'appended',
    transcript: {
      ...f.entries[0].transcript!,
      source: { kind: 'entry' as const, target: f.target, entryId: 'appended' },
      parts: [part('m0.b0', 'appended')],
    },
  };
  await f.publish({ ...f.snapshot, entries: [entry, ...f.snapshot.entries] });
  await published(2);
  assert.equal(f.state.entries.at(-1)!.id, 'appended');
  const snapshot = f.published;
  await f.transcript.openFind();
  await published(3);
  assert.equal(f.published, snapshot, 'a state change alone keeps the snapshot');
  const before = f.state;
  await f.publish(structuredClone(f.snapshot));
  await tick();
  assert.equal(f.publications, publications + 3);
  assert.equal(f.state, before);
});

test('part and manifest failures stay on their own state, apart from the history error', async (t) => {
  const f = await transcriptHarness(t, 640);
  const source = f.entries[630].transcript!.source;
  const selection = { partId: 'm0.b0', bytes: 9, revision: digest('same text') };
  const contentUnavailable = new HostUnavailableError({ reason: 'failed' }),
    historyUnavailable = new HostUnavailableError({ reason: 'reply-lost' });
  let contentFails = true;
  f.handlers.set('getChatTranscriptContent', async (_input, _signal, fallback) => {
    if (contentFails) throw contentUnavailable;
    return fallback();
  });
  await f.transcript.loadPart(source, selection);
  await f.transcript.loadManifest(source);
  let state = f.state;
  assert.equal(state.error, null, 'a content failure does not block history paging');
  assert.deepEqual(
    state.content.map(({ status, error }) => ({ status, error })),
    [{ status: 'error', error: contentUnavailable.message }],
  );
  assert.equal(state.manifest?.status, 'error');
  assert.equal(state.manifest?.error, contentUnavailable.message);

  // A failed page read keeps its error while content reads start and settle, so nothing
  // retries it until the reader does.
  let historyFails = true;
  f.handlers.set('getChatHistoryAround', async (_input, _signal, fallback) => {
    if (historyFails) throw historyUnavailable;
    return fallback();
  });
  await f.transcript.showEarlier();
  assert.equal(f.state.error, historyUnavailable.message);
  contentFails = false;
  await f.transcript.loadPart(source, selection, true);
  await f.transcript.loadManifest(source, true);
  state = f.state;
  assert.equal(state.error, historyUnavailable.message);
  assert.equal(state.content[0]?.status, 'complete');
  historyFails = false;
  await f.transcript.showEarlier();
  assert.equal(f.state.error, null);
});
