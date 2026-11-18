import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaledTranscriptLimits, transcriptHarness, until } from './transcript-fixture.ts';

for (const late of ['success', 'error'])
  test(`manual navigation wins an evicted-match replay with late ${late}`, async (t) => {
    const f = await transcriptHarness(t, 138, { limits: scaledTranscriptLimits });
    await f.transcript.findTranscript('same');
    await until(() => f.state.view.anchor?.key === 'entry:e0');
    await f.transcript.cancelFindReveal();
    assert.equal(f.state.find.revealing, false);
    const replayGate = Promise.withResolvers<void>(),
      manualGate = Promise.withResolvers<void>();
    let replaySignal: AbortSignal | undefined, manualSignal: AbortSignal | undefined;
    f.handlers.set('findChatTranscript', async (_input, signal, fallback) => {
      replaySignal = signal;
      await replayGate.promise;
      if (late === 'error') throw Error('obsolete replay error');
      return fallback();
    });
    f.handlers.set('getChatHistoryAround', async (input, signal, fallback) => {
      if ((input as { entryId: string }).entryId === 'e50') {
        manualSignal = signal;
        await manualGate.promise;
      }
      return fallback();
    });
    try {
      const next = f.transcript.moveFind('next');
      await until(() => !!replaySignal);
      const manual = f.transcript.jumpToEntry('e50');
      await until(() => !!manualSignal);
      replayGate.resolve();
      await next;
      assert.equal(f.state.find.error, null, 'cancelled replay must not publish a stale error');
      assert.equal(manualSignal!.aborted, false, 'older replay must leave manual navigation alive');
      manualGate.resolve();
      await manual;
      assert.equal(f.state.view.anchor?.key, 'entry:e50');
    } finally {
      replayGate.resolve();
      manualGate.resolve();
    }
  });
