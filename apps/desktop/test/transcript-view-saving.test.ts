import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatController, TranscriptView } from '@moonbase/application/chat';
import { createViewSaver } from '../src/renderer/chat/transcript-view-saving.ts';

function fakeController() {
  const state = {
    selected: { conversationId: 'first' } as unknown,
    view: { anchor: null, expanded: ['kept'] } as TranscriptView,
    writes: [] as TranscriptView[],
  };
  const controller = {
    getSnapshot: () => ({ selected: state.selected, transcript: { view: state.view } }),
    setTranscriptView: (view: TranscriptView) => {
      state.writes.push(view);
      state.view = structuredClone(view);
    },
  } as unknown as Pick<ChatController, 'getSnapshot' | 'setTranscriptView'>;
  return { state, controller };
}
const at = (entryId: string, offset = 0) => ({ key: 'entry:' + entryId, offset });

test('saves write only a changed anchor and keep expansions', () => {
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, () => 1);
  views.save(at('a'));
  views.save({ offset: 0, key: 'entry:a' });
  assert.deepEqual(state.writes, [{ anchor: at('a'), expanded: ['kept'] }]);
  views.save(at('a', 4));
  // Following saves no anchor; repeating it writes nothing.
  views.save(null);
  views.save(null);
  assert.deepEqual(
    state.writes.map((view) => view.anchor),
    [at('a'), at('a', 4), null],
  );
});

test('a save never lands in another conversation', () => {
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, () => 1);
  views.save(at('first-row'));
  // The selection switches; the old view's last scroll end must not write into the new one.
  state.selected = { conversationId: 'second' };
  state.view = { anchor: null, expanded: [] };
  views.save(at('first-row', 30));
  assert.equal(state.view.anchor, null);
  assert.equal(state.writes.length, 1);
});

test('an offset that moved less than a device pixel keeps the saved anchor', () => {
  const { state, controller } = fakeController();
  let devicePixel = 1;
  const views = createViewSaver(controller, () => devicePixel);
  views.save(at('a', 52));
  // A restore scrolled to a whole pixel reports a fraction off; it isn't a new position.
  views.save(at('a', 51.625));
  views.save(at('a', 52.5));
  assert.deepEqual(
    state.writes.map((view) => view.anchor),
    [at('a', 52)],
  );
  views.save(at('a', 53));
  views.save(at('b', 53.25));
  // Zoomed out, a device pixel is larger than a CSS pixel.
  devicePixel = 1.25;
  views.save(at('b', 54.25));
  assert.deepEqual(
    state.writes.map((view) => view.anchor),
    [at('a', 52), at('a', 53), at('b', 53.25)],
  );
});
