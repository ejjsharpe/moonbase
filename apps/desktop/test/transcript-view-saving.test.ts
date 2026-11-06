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
  const views = createViewSaver(controller);
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
  const views = createViewSaver(controller);
  views.save(at('first-row'));
  // The selection switches; the old view's last scroll end must not write into the new one.
  state.selected = { conversationId: 'second' };
  state.view = { anchor: null, expanded: [] };
  views.save(at('first-row', 30));
  assert.equal(state.view.anchor, null);
  assert.equal(state.writes.length, 1);
});

test('supplied anchors apply only when their value is new to this view', () => {
  const { state, controller } = fakeController();
  const views = createViewSaver(controller);
  // View memory supplies an anchor; a disclosure toggle rewrites the same view.
  assert.equal(views.receive({ offset: 16, key: 'entry:saved' }), true);
  assert.equal(views.receive(at('saved', 16)), false);
  // This view's own save echoes back without re-applying.
  views.save(at('read', 2));
  assert.equal(views.receive(structuredClone(state.view.anchor!)), false);
  // The application moving the anchor (Find, around-entry navigation) applies.
  assert.equal(views.receive(at('found')), true);
  assert.equal(views.receive(at('saved', 16)), true);
});
