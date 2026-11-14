import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptController, tick } from './transcript-fixture.ts';
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await tick();
  }
  assert(check());
}
for (const late of ['success', 'error'])
  test(`manual navigation wins an evicted-match replay with late ${late}`, async (t) => {
    const f = await transcriptController(t, 1100);
    await f.controller.findTranscript('same');
    await until(() => f.controller.getSnapshot().transcript.view.anchor?.key === 'entry:e0');
    f.controller.cancelFindReveal();
    assert.equal(f.controller.getSnapshot().transcript.find.revealing, false);
    let releaseReplay!: () => void, releaseManual!: () => void;
    let replaySignal: AbortSignal | undefined, manualSignal: AbortSignal | undefined;
    const replayGate = new Promise<void>((r) => (releaseReplay = r));
    const manualGate = new Promise<void>((r) => (releaseManual = r));
    f.handlers.set('findChatTranscript', async (_input, signal, fallback) => {
      replaySignal = signal;
      await replayGate;
      if (late === 'error') throw Error('obsolete replay error');
      return fallback();
    });
    f.handlers.set('getChatHistoryAround', async (input, signal, fallback) => {
      if ((input as { entryId: string }).entryId === 'e50') {
        manualSignal = signal;
        await manualGate;
      }
      return fallback();
    });
    let next: Promise<void> | undefined, manual: Promise<unknown> | undefined;
    try {
      next = f.controller.nextFindMatch();
      await until(() => !!replaySignal);
      manual = f.controller.jumpToEntry('e50');
      await until(() => !!manualSignal);
      console.log('replay aborted when manual began:', replaySignal!.aborted);
      releaseReplay();
      await next;
      assert.equal(
        f.controller.getSnapshot().transcript.find.error,
        null,
        'cancelled replay must not publish a stale error',
      );
      assert.equal(manualSignal!.aborted, false, 'older replay must leave manual navigation alive');
      releaseManual();
      await manual;
      assert.equal(f.controller.getSnapshot().transcript.view.anchor?.key, 'entry:e50');
    } finally {
      releaseReplay();
      releaseManual();
      await next;
      await manual;
      console.log(
        'final anchor:',
        f.controller.getSnapshot().transcript.view.anchor?.key,
        'manual aborted:',
        manualSignal?.aborted,
      );
    }
  });
