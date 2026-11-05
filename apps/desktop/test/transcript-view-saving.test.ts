import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
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
const at = (entryId: string, offset = 0) => ({ entryId, offset });

test('leaving following saves at once; later scroll saves wait until scrolling rests', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, 150);
  // The application stops following before the first adjustment settles.
  views.deferring(() => views.save(at('a')));
  assert.deepEqual(state.writes, [{ anchor: at('a'), expanded: ['kept'] }]);
  views.deferring(() => views.save(at('b', 4)));
  views.deferring(() => views.save(at('c', 8)));
  assert.equal(state.writes.length, 1);
  mock.timers.tick(149);
  assert.equal(state.writes.length, 1);
  mock.timers.tick(1);
  assert.deepEqual(state.writes.at(-1), { anchor: at('c', 8), expanded: ['kept'] });
  // Returning to following clears the anchor once scrolling rests; nothing is written twice.
  views.deferring(() => views.save(null));
  mock.timers.tick(150);
  assert.equal(state.view.anchor, null);
  views.save(null);
  assert.equal(state.writes.length, 3);
});

test('a queued save is flushed before navigation reads the view, and jumping to latest drops it', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, 150);
  views.save(at('a'));
  views.deferring(() => views.save(at('b')));
  views.flush();
  assert.deepEqual(state.view.anchor, at('b'));
  views.deferring(() => views.save(at('c')));
  views.cancel();
  mock.timers.tick(500);
  assert.deepEqual(state.view.anchor, at('b'));
});

test('a queued save never lands in another conversation', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setTimeout'] });
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, 150);
  views.save(at('first-row'));
  views.deferring(() => views.save(at('first-row', 30)));
  // The selection switches; the old view's unmount flush must not write into the new one.
  state.selected = { conversationId: 'second' };
  state.view = { anchor: null, expanded: [] };
  views.flush();
  mock.timers.tick(500);
  assert.equal(state.view.anchor, null);
  assert.equal(state.writes.length, 1);
});

test('supplied anchors apply only when their value is new to this view', () => {
  const { state, controller } = fakeController();
  const views = createViewSaver(controller, 150);
  // View memory supplies an anchor; a disclosure toggle rewrites the same view.
  assert.equal(views.receive({ offset: 16, entryId: 'saved' }), true);
  assert.equal(views.receive(at('saved', 16)), false);
  // This view's own save echoes back without re-applying.
  views.save(at('read', 2));
  assert.equal(views.receive(structuredClone(state.view.anchor!)), false);
  // The application moving the anchor (Find, around-entry navigation) applies.
  assert.equal(views.receive(at('found')), true);
  assert.equal(views.receive(at('saved', 16)), true);
});
