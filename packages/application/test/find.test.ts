import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatOutput } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/errors';
import { transcriptController, tick } from './transcript-fixture.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert(check());
}

test('selected Find scans empty intermediate slices, pins first match, bounds retention and replays the fixed cutoff', async (t) => {
  const f = await transcriptController(t, 1100);
  await f.controller.findTranscript('same');
  let state = f.controller.getSnapshot().transcript.find;
  assert.equal(state.status, 'complete');
  assert.equal(state.count, 1100);
  assert.equal(state.active?.source.entryId, 'e0');
  assert.equal(state.matches.length, 256);
  assert.equal(state.retainedFrom, 844);
  assert.equal(state.upperEntryId, 'e1099');
  await f.controller.nextFindMatch();
  state = f.controller.getSnapshot().transcript.find;
  assert.equal(state.active?.source.entryId, 'e1');
  assert.equal(state.activeIndex, 1);
  assert(
    f.calls.some(
      (call) =>
        call.operation === 'findChatTranscript' && (call.input as { cursor?: string }).cursor,
    ),
  );
  assert(f.controller.getSnapshot().transcript.entries.some((entry) => entry.id === 'e1'));
  await f.controller.previousFindMatch();
  assert.equal(f.controller.getSnapshot().transcript.find.active?.source.entryId, 'e0');
  await f.controller.findTranscript('no match');
  assert.equal(f.controller.getSnapshot().transcript.find.status, 'complete');
  assert.equal(f.controller.getSnapshot().transcript.find.count, 0);
});

test('query replacement, close, Hide and disposal fence late results and errors but retain actual read cleanup', async (t) => {
  for (const action of ['replace', 'close', 'hide', 'dispose'] as const) {
    const f = await transcriptController(t, 32);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered = false,
      signal: AbortSignal | undefined;
    f.handlers.set('findChatTranscript', async (_input, abort, fallback) => {
      entered = true;
      signal = abort;
      await held;
      if (action === 'close')
        throw new ApplicationError({ code: 'Unavailable', message: 'obsolete failure' });
      return fallback();
    });
    const find = f.controller.findTranscript('same');
    await until(() => entered);
    let disposed = false,
      disposal: Promise<void> | undefined;
    if (action === 'replace') {
      f.handlers.delete('findChatTranscript');
      await f.controller.findTranscript('different');
    }
    if (action === 'close') f.controller.closeFind();
    if (action === 'hide') void f.controller.detach();
    if (action === 'dispose')
      disposal = f.controller.dispose().then(() => {
        disposed = true;
      });
    await tick();
    assert(signal?.aborted);
    assert.equal(disposed, false);
    release();
    await find;
    await disposal;
    const state = f.controller.getSnapshot().transcript.find;
    assert.notEqual(state.query, 'same');
    assert.equal(state.error, null);
  }
});

test('Find rejects wrong query/authority/cutoff/ranges and advertised failures remain visible; older hosts explain upgrade', async (t) => {
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
    const f = await transcriptController(t, 32);
    f.handlers.set('findChatTranscript', async (_input, _signal, fallback) =>
      change(fallback() as ChatOutput<'findChatTranscript'>),
    );
    await f.controller.findTranscript('same');
    assert.equal(f.controller.getSnapshot().transcript.find.status, 'error');
  }
  const f = await transcriptController(t, 32);
  f.handlers.set('findChatTranscript', async () => {
    throw new ApplicationError({ code: 'Unavailable', message: 'advertised read failed' });
  });
  await f.controller.findTranscript('same');
  assert.match(f.controller.getSnapshot().transcript.find.error!, /advertised read failed/);
});

test('retained text chunks retain UTF16 bases independently of byte offsets', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source;
  const text = '😀'.repeat(9000);
  f.sources.get(JSON.stringify(source))!.data[0] = text;
  await f.controller.loadTranscriptManifest(source);
  const { partId, bytes, revision } = f.controller.getSnapshot().transcript.manifest!.parts[0];
  const selection = { partId, bytes, revision };
  await f.controller.loadTranscriptPart(source, selection);
  await f.controller.loadTranscriptPart(source, selection);
  const content = f.controller.getSnapshot().transcript.content[0];
  assert.equal(content.loadedText, text.length);
  assert.equal(content.chunks[1].textOffset, content.chunks[0].data.length);
});

test('Find reaches beginning/middle/end on local and remote controllers and surfaces missing targets', async (t) => {
  for (const local of [true, false]) {
    const f = await transcriptController(t, 1100, local);
    for (const index of [0, 550, 1099])
      f.sources.get(JSON.stringify(f.entries[index].transcript!.source))!.data[0] = 'needle';
    await f.controller.findTranscript('needle');
    assert.equal(f.controller.getSnapshot().transcript.find.count, 3);
    for (const index of [550, 1099]) {
      await f.controller.nextFindMatch();
      assert.equal(f.controller.getSnapshot().transcript.find.active?.source.entryId, `e${index}`);
      assert(
        f.controller.getSnapshot().transcript.entries.some((entry) => entry.id === `e${index}`),
      );
    }
    f.publish({ ...f.snapshot, transcriptBoundary: 'new-entry' });
    assert.equal(f.controller.getSnapshot().transcript.find.refreshAvailable, true);
    assert.equal(f.controller.getSnapshot().transcript.find.upperEntryId, 'e1099');
    f.handlers.set('getChatHistoryAround', async () => {
      throw new ApplicationError({ code: 'InvalidInput', message: 'Saved entry is unavailable.' });
    });
    await f.controller.previousFindMatch();
    assert.match(f.controller.getSnapshot().transcript.find.error!, /Saved entry is unavailable/);
  }
});

test('empty Find slices remain searching until completion and old hosts give an explicit upgrade state', async (t) => {
  const f = await transcriptController(t, 1100);
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('findChatTranscript', async (_input, _signal, fallback) => {
    if (entered) await held;
    entered = true;
    return fallback();
  });
  const pending = f.controller.findTranscript('absent');
  await until(
    () => entered && f.calls.filter((call) => call.operation === 'findChatTranscript').length > 1,
  );
  assert.equal(f.controller.getSnapshot().transcript.find.status, 'searching');
  assert.equal(f.controller.getSnapshot().transcript.find.count, 0);
  release();
  await pending;
  assert.equal(f.controller.getSnapshot().transcript.find.status, 'complete');
  await f.controller.detach();
  f.handlers.set('getChatHost', async (_input, _signal, fallback) => ({
    ...(fallback() as object),
    features: ['transcript-v1'],
  }));
  await f.controller.start();
  const calls = f.calls.filter((call) => call.operation === 'findChatTranscript').length;
  await f.controller.findTranscript('literal');
  assert.equal(f.controller.getSnapshot().transcript.capabilities.find, 'unavailable');
  assert.match(f.controller.getSnapshot().transcript.find.error!, /Upgrade this host/);
  assert.equal(f.calls.filter((call) => call.operation === 'findChatTranscript').length, calls);
});

test('replacing Find aborts matched hydration immediately and keeps its real settlement owned', async (t) => {
  const f = await transcriptController(t, 32);
  await f.controller.findTranscript('same');
  const source = f.entries[0].transcript!.source;
  let release!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('getChatTranscriptContent', async (_input, abort, fallback) => {
    signal = abort;
    await held;
    return fallback();
  });
  const hydration = f.controller.loadTranscriptManifest(source);
  await until(() => !!signal);
  await f.controller.findTranscript('different');
  assert(signal?.aborted);
  let disposed = false;
  const dispose = f.controller.dispose().then(() => (disposed = true));
  await tick();
  assert.equal(disposed, false);
  release();
  await hydration;
  await dispose;
});

test('deliberate navigation cancels a held Find reveal without dropping query or active result identity', async (t) => {
  const f = await transcriptController(t, 64);
  let release!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('getChatHistoryAround', async (_input, abort, fallback) => {
    signal = abort;
    await held;
    return fallback();
  });
  await f.controller.findTranscript('same');
  await until(() => !!signal);
  const active = f.controller.getSnapshot().transcript.find.active;
  f.controller.cancelFindReveal();
  assert(signal?.aborted);
  const before = f.controller.getSnapshot().transcript.entries;
  release();
  await tick();
  const state = f.controller.getSnapshot().transcript;
  assert.equal(state.find.revealing, false);
  assert.equal(state.find.query, 'same');
  assert.deepEqual(state.find.active, active);
  assert.deepEqual(state.entries, before);
});

test('cancelled Find reveal cannot cancel or overwrite a newer manual history read', async (t) => {
  const f = await transcriptController(t, 100);
  let releaseOld!: () => void, releaseManual!: () => void;
  const old = new Promise<void>((resolve) => (releaseOld = resolve)),
    manual = new Promise<void>((resolve) => (releaseManual = resolve));
  let oldSignal: AbortSignal | undefined, manualSignal: AbortSignal | undefined;
  f.handlers.set('getChatHistoryAround', async (input, signal, fallback) => {
    if ((input as { entryId: string }).entryId === 'e0') {
      oldSignal = signal;
      await old;
      throw new ApplicationError({ code: 'Unavailable', message: 'obsolete Find reveal error' });
    }
    manualSignal = signal;
    await manual;
    return fallback();
  });
  await f.controller.findTranscript('same');
  await until(() => !!oldSignal);
  const active = f.controller.getSnapshot().transcript.find.active;
  const navigation = f.controller.jumpToEntry('e50');
  await until(() => !!manualSignal);
  assert(oldSignal?.aborted);
  assert.equal(manualSignal?.aborted, false);
  f.controller.cancelFindReveal();
  releaseOld();
  await tick();
  assert.equal(manualSignal?.aborted, false);
  assert.equal(f.controller.getSnapshot().transcript.error, null);
  assert.equal(f.controller.getSnapshot().transcript.find.error, null);
  releaseManual();
  await navigation;
  const state = f.controller.getSnapshot().transcript;
  assert(state.entries.some((entry) => entry.id === 'e50'));
  assert.equal(state.view.anchor?.entryId, 'e50');
  assert.deepEqual(state.find.active, active);
  assert.equal(state.find.query, 'same');
});

test('reading before a delayed first result suppresses automatic reveal without cancelling the query', async (t) => {
  const f = await transcriptController(t, 100);
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.handlers.set('findChatTranscript', async (_input, _signal, fallback) => {
    entered = true;
    await held;
    return fallback();
  });
  const query = f.controller.findTranscript('same');
  await until(() => entered);
  await f.controller.jumpToEntry('e50');
  release();
  await query;
  const state = f.controller.getSnapshot().transcript;
  assert.equal(state.find.status, 'complete');
  assert.equal(state.find.count, 100);
  assert.equal(state.find.active?.source.entryId, 'e0');
  assert.equal(state.find.revealing, false);
  assert.equal(state.view.anchor?.entryId, 'e50');
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
    const f = await transcriptController(t, 64, false, { transcriptWatchRetryMs: [] });
    let release!: () => void, signal: AbortSignal | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.handlers.set('findChatTranscript', async (_input, abort, fallback) => {
      signal = abort;
      await held;
      return fallback();
    });
    const pending = f.controller.findTranscript('same');
    await until(() => !!signal);
    if (failure === 'reconnecting') f.publish({ ...f.snapshot, observationStatus: 'reconnecting' });
    else f.fail(new ApplicationError({ code: 'Unavailable', message: 'Observation stopped' }));
    assert(signal?.aborted);
    let state = f.controller.getSnapshot().transcript.find;
    assert.equal(state.status, 'error');
    assert.equal(state.revealing, false);
    const error = state.error;
    release();
    await pending;
    await tick();
    state = f.controller.getSnapshot().transcript.find;
    assert.equal(state.error, error);
    assert.equal(state.count, 0);
    if (failure === 'failed') {
      await f.controller.findTranscript('new query');
      assert.match(f.controller.getSnapshot().transcript.find.error!, /Reconnect or reopen/);
    }
  }
});

test('closing Find forgets its fixed boundary, so later snapshots never offer a refresh', async (t) => {
  const f = await transcriptController(t, 64);
  await f.controller.findTranscript('same');
  assert.equal(f.controller.getSnapshot().transcript.find.upperEntryId, 'e63');
  f.publish({ ...f.snapshot, transcriptBoundary: 'e10' });
  assert.equal(f.controller.getSnapshot().transcript.find.refreshAvailable, true);
  f.controller.closeFind();
  f.publish({ ...f.snapshot, transcriptBoundary: 'e11' });
  const find = f.controller.getSnapshot().transcript.find;
  assert.equal(find.open, false);
  assert.equal(find.refreshAvailable, false);
});

test('Find accepts original-text matches under simple Unicode case folding', async (t) => {
  const f = await transcriptController(t, 1);
  const source = f.entries[0].transcript!.source;
  f.fixture.sources.set(JSON.stringify(source), {
    source,
    data: ['Ein STRAẞE 🌔 und ΣΟΦΟΣ, then straße 🌔 and σοφος'],
  });
  await f.controller.findTranscript('straße 🌔');
  let find = f.controller.getSnapshot().transcript.find;
  assert.equal(find.error, null);
  assert.deepEqual(
    find.matches.map((match) => [match.start, match.end]),
    [
      [4, 13],
      [30, 39],
    ],
  );
  await f.controller.findTranscript('σοφοσ');
  find = f.controller.getSnapshot().transcript.find;
  assert.equal(find.error, null);
  assert.equal(find.count, 2);
  await f.controller.findTranscript('STRASSE');
  assert.equal(f.controller.getSnapshot().transcript.find.count, 0);
});
