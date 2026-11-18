import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { scaledTranscriptLimits, tick, transcriptHarness, until } from './transcript-fixture.ts';

test('selected Find scans empty intermediate slices, pins first match, bounds retention and replays the fixed cutoff', async (t) => {
  const f = await transcriptHarness(t, 138, { limits: scaledTranscriptLimits });
  await f.transcript.findTranscript('same');
  let state = f.state.find;
  assert.equal(state.status, 'complete');
  assert.equal(state.count, 138);
  assert.equal(state.active?.source.entryId, 'e0');
  assert.equal(state.matches.length, f.limits.findMatches);
  assert.equal(state.retainedFrom, 138 - f.limits.findMatches);
  assert.equal(state.upperEntryId, 'e137');
  await f.transcript.moveFind('next');
  state = f.state.find;
  assert.equal(state.active?.source.entryId, 'e1');
  assert.equal(state.activeIndex, 1);
  assert(
    f.calls.some(
      (call) =>
        call.operation === 'findChatTranscript' && (call.input as { cursor?: string }).cursor,
    ),
  );
  assert(f.state.entries.some((entry) => entry.id === 'e1'));
  await f.transcript.moveFind('previous');
  assert.equal(f.state.find.active?.source.entryId, 'e0');
  await f.transcript.findTranscript('no match');
  assert.equal(f.state.find.status, 'complete');
  assert.equal(f.state.find.count, 0);
});

test('query replacement, closing Find and closing the transcript fence late results and errors', async (t) => {
  for (const action of ['replace', 'close', 'scope'] as const) {
    const f = await transcriptHarness(t, 32);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered = false,
      signal: AbortSignal | undefined;
    f.handlers.set('findChatTranscript', async (_input, abort, fallback) => {
      entered = true;
      signal = abort;
      await held;
      if (action === 'close') throw new HostUnavailableError({ reason: 'failed' });
      return fallback();
    });
    const find = f.transcript.findTranscript('same');
    await until(() => entered);
    if (action === 'replace') {
      f.handlers.delete('findChatTranscript');
      await f.transcript.findTranscript('different');
    }
    if (action === 'close') await f.transcript.closeFind();
    // Closing the transcript does not wait for the host to answer the cancelled read.
    if (action === 'scope') await f.close();
    assert(signal?.aborted);
    const publications = f.publications;
    release();
    await find;
    await tick();
    const state = f.state.find;
    if (action === 'scope') assert.equal(f.publications, publications);
    else assert.notEqual(state.query, 'same');
    assert.equal(state.error, null);
  }
});

test('Find rejects wrong query/authority/cutoff/ranges and host read failures remain visible', async (t) => {
  for (const change of [
    (page: ChatOutput<'findChatTranscript'>) => ({ ...page, query: 'wrong' }),
    (page: ChatOutput<'findChatTranscript'>) => ({ ...page, cursor: 'wrong' }),
    (page: ChatOutput<'findChatTranscript'>) => ({
      ...page,
      matches: [page.matches[0], page.matches[0]],
    }),
    (page: ChatOutput<'findChatTranscript'>) => ({
      ...page,
      matches: [{ ...page.matches[0], end: 5 }],
    }),
    (page: ChatOutput<'findChatTranscript'>) => ({
      ...page,
      matches: [
        {
          ...page.matches[0],
          source: { ...page.matches[0].source, target: { ...page.target, actorId: 'foreign' } },
        },
      ],
    }),
    (page: ChatOutput<'findChatTranscript'>) => ({
      ...page,
      matches: [{ ...page.matches[0], end: 9999 }],
    }),
    (page: ChatOutput<'findChatTranscript'>) => ({
      ...page,
      nextCursor: 'stalled',
      progress: { entries: 0, bytes: 0 },
    }),
  ]) {
    const f = await transcriptHarness(t, 32);
    f.handlers.set('findChatTranscript', async (_input, _signal, fallback) =>
      change(fallback() as ChatOutput<'findChatTranscript'>),
    );
    await f.transcript.findTranscript('same');
    assert.equal(f.state.find.status, 'error');
  }
  const f = await transcriptHarness(t, 32);
  f.handlers.set('findChatTranscript', async () => {
    throw new HostUnavailableError({ reason: 'reply-lost' });
  });
  await f.transcript.findTranscript('same');
  assert.equal(f.state.find.error, new HostUnavailableError({ reason: 'reply-lost' }).message);
});

test('retained text chunks retain UTF16 bases independently of byte offsets', async (t) => {
  const f = await transcriptHarness(t, 1);
  const source = f.entries[0].transcript!.source;
  const text = '😀'.repeat(9000);
  f.sources.get(JSON.stringify(source))!.data[0] = text;
  await f.transcript.loadManifest(source);
  const { partId, bytes, revision } = f.state.manifest!.parts[0];
  const selection = { partId, bytes, revision };
  await f.transcript.loadPart(source, selection);
  await f.transcript.loadPart(source, selection);
  const content = f.state.content[0];
  assert.equal(content.loadedText, text.length);
  assert.equal(content.chunks[1].textOffset, content.chunks[0].data.length);
});

test('Find reaches beginning/middle/end and surfaces missing targets', async (t) => {
  const f = await transcriptHarness(t, 138, { limits: scaledTranscriptLimits });
  for (const index of [0, 69, 137])
    f.sources.get(JSON.stringify(f.entries[index].transcript!.source))!.data[0] = 'needle';
  await f.transcript.findTranscript('needle');
  assert.equal(f.state.find.count, 3);
  for (const index of [69, 137]) {
    await f.transcript.moveFind('next');
    assert.equal(f.state.find.active?.source.entryId, `e${index}`);
    assert(f.state.entries.some((entry) => entry.id === `e${index}`));
  }
  await f.publish({ ...f.snapshot, transcriptBoundary: 'new-entry' });
  assert.equal(f.state.find.refreshAvailable, true);
  assert.equal(f.state.find.upperEntryId, 'e137');
  f.handlers.set('getChatHistoryAround', async () => {
    throw new InvalidChatRequestError({ problem: 'entry' });
  });
  await f.transcript.moveFind('previous');
  assert.equal(f.state.find.error, new InvalidChatRequestError({ problem: 'entry' }).message);
});

test('empty Find slices remain searching until completion', async (t) => {
  const f = await transcriptHarness(t, 1100);
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('findChatTranscript', async (_input, _signal, fallback) => {
    if (entered) await held;
    entered = true;
    return fallback();
  });
  const pending = f.transcript.findTranscript('absent');
  await until(
    () => entered && f.calls.filter((call) => call.operation === 'findChatTranscript').length > 1,
  );
  assert.equal(f.state.find.status, 'searching');
  assert.equal(f.state.find.count, 0);
  release();
  await pending;
  assert.equal(f.state.find.status, 'complete');
});

test('replacing Find aborts matched hydration immediately', async (t) => {
  const f = await transcriptHarness(t, 32);
  await f.transcript.findTranscript('same');
  const source = f.entries[0].transcript!.source;
  let release!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('getChatTranscriptContent', async (_input, abort, fallback) => {
    signal = abort;
    await held;
    return fallback();
  });
  const hydration = f.transcript.loadManifest(source);
  await until(() => !!signal);
  await f.transcript.findTranscript('different');
  assert(signal?.aborted);
  release();
  await hydration;
  assert.equal(f.state.manifest?.status, 'partial');
});

test('deliberate navigation cancels a held Find reveal without dropping query or active result identity', async (t) => {
  const f = await transcriptHarness(t, 64);
  let release!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('getChatHistoryAround', async (_input, abort, fallback) => {
    signal = abort;
    await held;
    return fallback();
  });
  await f.transcript.findTranscript('same');
  await until(() => !!signal);
  const active = f.state.find.active;
  await f.transcript.cancelFindReveal();
  assert(signal?.aborted);
  const before = f.state.entries;
  release();
  await tick();
  const state = f.state;
  assert.equal(state.find.revealing, false);
  assert.equal(state.find.query, 'same');
  assert.deepEqual(state.find.active, active);
  assert.deepEqual(state.entries, before);
});

test('paging near a revealed match leaves the reveal', async (t) => {
  const f = await transcriptHarness(t, 100);
  await f.transcript.findTranscript('same');
  await until(() => f.state.view.anchor?.key === 'entry:e0');
  // The list pages on its own near an edge; only the reader's input ends the reveal.
  await f.transcript.showLater();
  const state = f.state;
  assert.equal(state.find.revealing, true);
  assert.equal(state.view.anchor?.key, 'entry:e0');
  // The reveal read e0–e16 around its match; the page continued after them.
  assert(state.entries.some((entry) => entry.id === 'e17'));
  assert.equal(state.error, null);
});

test('cancelled Find reveal cannot cancel or overwrite a newer manual history read', async (t) => {
  const f = await transcriptHarness(t, 100);
  let releaseOld!: () => void, releaseManual!: () => void;
  const old = new Promise<void>((resolve) => (releaseOld = resolve)),
    manual = new Promise<void>((resolve) => (releaseManual = resolve));
  let oldSignal: AbortSignal | undefined, manualSignal: AbortSignal | undefined;
  f.handlers.set('getChatHistoryAround', async (input, signal, fallback) => {
    if ((input as { entryId: string }).entryId === 'e0') {
      oldSignal = signal;
      await old;
      throw new HostUnavailableError({ reason: 'failed' });
    }
    manualSignal = signal;
    await manual;
    return fallback();
  });
  await f.transcript.findTranscript('same');
  await until(() => !!oldSignal);
  const active = f.state.find.active;
  const navigation = f.transcript.jumpToEntry('e50');
  await until(() => !!manualSignal);
  assert(oldSignal?.aborted);
  assert.equal(manualSignal?.aborted, false);
  await f.transcript.cancelFindReveal();
  releaseOld();
  await tick();
  assert.equal(manualSignal?.aborted, false);
  assert.equal(f.state.error, null);
  assert.equal(f.state.find.error, null);
  releaseManual();
  await navigation;
  const state = f.state;
  assert(state.entries.some((entry) => entry.id === 'e50'));
  assert.equal(state.view.anchor?.key, 'entry:e50');
  assert.deepEqual(state.find.active, active);
  assert.equal(state.find.query, 'same');
});

test('reading before a delayed first result suppresses automatic reveal without cancelling the query', async (t) => {
  const f = await transcriptHarness(t, 100);
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('findChatTranscript', async (_input, _signal, fallback) => {
    entered = true;
    await held;
    return fallback();
  });
  const query = f.transcript.findTranscript('same');
  await until(() => entered);
  await f.transcript.jumpToEntry('e50');
  release();
  await query;
  const state = f.state;
  assert.equal(state.find.status, 'complete');
  assert.equal(state.find.count, 100);
  assert.equal(state.find.active?.source.entryId, 'e0');
  assert.equal(state.find.revealing, false);
  assert.equal(state.view.anchor?.key, 'entry:e50');
  assert(
    !f.calls.some(
      (call) =>
        call.operation === 'getChatHistoryAround' &&
        (call.input as { entryId: string }).entryId === 'e0',
    ),
  );
});

test('reconnecting and failed observations cancel Find and keep a visible retry state without stale publication', async (t) => {
  for (const failure of ['reconnecting', 'failed'] as const) {
    const f = await transcriptHarness(t, 64, { local: false });
    let release!: () => void, signal: AbortSignal | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.handlers.set('findChatTranscript', async (_input, abort, fallback) => {
      signal = abort;
      await held;
      return fallback();
    });
    const pending = f.transcript.findTranscript('same');
    await until(() => !!signal);
    if (failure === 'reconnecting')
      await f.publish({ ...f.snapshot, observationStatus: 'reconnecting' });
    else await f.transcript.fail(new HostUnavailableError({ reason: 'watch-ended' }));
    assert(signal?.aborted);
    let state = f.state.find;
    assert.equal(state.status, 'error');
    assert.equal(state.revealing, false);
    const error = state.error;
    release();
    await pending;
    await tick();
    state = f.state.find;
    assert.equal(state.error, error);
    assert.equal(state.count, 0);
    if (failure === 'failed') {
      await f.transcript.findTranscript('new query');
      assert.match(f.state.find.error!, /Reconnect or reopen/);
    }
  }
});

test('closing Find forgets its fixed boundary, so later snapshots never offer a refresh', async (t) => {
  const f = await transcriptHarness(t, 64);
  await f.transcript.findTranscript('same');
  assert.equal(f.state.find.upperEntryId, 'e63');
  await f.publish({ ...f.snapshot, transcriptBoundary: 'e10' });
  assert.equal(f.state.find.refreshAvailable, true);
  await f.transcript.closeFind();
  await f.publish({ ...f.snapshot, transcriptBoundary: 'e11' });
  const find = f.state.find;
  assert.equal(find.open, false);
  assert.equal(find.refreshAvailable, false);
});

test('Find accepts original-text matches under simple Unicode case folding', async (t) => {
  const f = await transcriptHarness(t, 1);
  const source = f.entries[0].transcript!.source;
  f.sources.set(JSON.stringify(source), {
    source,
    data: ['Ein STRAẞE 🌔 und ΣΟΦΟΣ, then straße 🌔 and σοφος'],
  });
  await f.transcript.findTranscript('straße 🌔');
  let find = f.state.find;
  assert.equal(find.error, null);
  assert.deepEqual(
    find.matches.map((match) => [match.start, match.end]),
    [
      [4, 13],
      [30, 39],
    ],
  );
  await f.transcript.findTranscript('σοφοσ');
  find = f.state.find;
  assert.equal(find.error, null);
  assert.equal(find.count, 2);
  await f.transcript.findTranscript('STRASSE');
  assert.equal(f.state.find.count, 0);
});
