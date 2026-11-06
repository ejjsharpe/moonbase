import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptViewAnchor } from '@moonbase/application/chat';
import {
  createTranscriptScroll,
  transitionTranscriptScroll,
  type TranscriptScroll,
  type TranscriptScrollEvent,
  type TranscriptViewport,
} from '../src/renderer/chat/transcript-scroll.ts';

const viewport = (change: Partial<TranscriptViewport> = {}): TranscriptViewport => ({
  top: 2000,
  bottom: 2000,
  atLatest: true,
  selected: false,
  earlier: true,
  boundary: false,
  ...change,
});
const saved: TranscriptViewAnchor = { entryId: 'entry-4', partId: 'm0.b1', offset: 16 };
const position: TranscriptViewAnchor = { entryId: 'entry-5', offset: 3 };
const wheel = (upward: boolean, change?: Partial<TranscriptViewport>) =>
  ({ type: 'input', device: 'wheel', upward, viewport: viewport(change) }) as const;
const scrolled = (change?: Partial<TranscriptViewport>, held = false) =>
  ({ type: 'scrolled', held, viewport: viewport(change) }) as const;
const navigate = (direction: 'earlier' | 'later', change?: Partial<TranscriptViewport>) =>
  ({ type: 'navigate', direction, viewport: viewport(change) }) as const;
const resized = (change?: Partial<TranscriptViewport>) =>
  ({ type: 'resized', viewport: viewport(change) }) as const;
function play(state: TranscriptScroll, ...events: TranscriptScrollEvent[]) {
  const instructions = [];
  for (const event of events) {
    const result = transitionTranscriptScroll(state, event);
    state = result.state;
    instructions.push(result.instruction);
  }
  return { state, instructions, last: instructions.at(-1)! };
}
const reading = () => play(createTranscriptScroll(null), scrolled()).state;

test('bottom follow keeps the end visible only at latest without a selection', () => {
  const following = createTranscriptScroll(null);
  assert.equal(following.mode, 'following');
  assert.deepEqual(play(following, resized()).last, { scroll: 'end' });
  assert.deepEqual(play(following, resized({ selected: true })).last, {});
  assert.deepEqual(play(following, resized({ atLatest: false })).last, {});
  const end = play(reading(), scrolled({ bottom: 10 }), {
    type: 'captured',
    position,
  });
  assert.equal(end.state.mode, 'following');
  assert.deepEqual(end.last, { save: null });
  assert.equal(play(reading(), scrolled({ bottom: 10, selected: true })).state.mode, 'reading');
  assert.equal(play(reading(), scrolled({ bottom: 10, atLatest: false })).state.mode, 'reading');
  assert.equal(play(following, scrolled({ bottom: 400 })).state.mode, 'reading');
  // A downward wheel or key at the end keeps following; upward input leaves it.
  assert.equal(play(following, wheel(false)).state.mode, 'following');
  const key = { type: 'input', device: 'key', upward: false, viewport: viewport() } as const;
  assert.equal(play(following, key).state.mode, 'following');
  assert.equal(play(following, wheel(true)).state.mode, 'reading');
});

test('pressing a control keeps following; a press that can select text or scroll leaves it', () => {
  const following = createTranscriptScroll(null);
  const press = (device: 'pointer' | 'control', upward = false) =>
    ({ type: 'input', device, upward, viewport: viewport() }) as const;
  // Copy, Activity and other controls at the end keep the end in view as output grows.
  const control = play(following, press('control'), resized());
  assert.equal(control.state.mode, 'following');
  assert.deepEqual(control.last, { scroll: 'end' });
  // Content may start a selection; the scrollbar or touch (upward) scrolls away.
  assert.equal(play(following, press('pointer')).state.mode, 'reading');
  assert.equal(play(following, press('pointer', true)).state.mode, 'reading');
  // A control press that is followed by scrolling away still leaves following.
  assert.equal(play(following, press('control'), scrolled({ bottom: 400 })).state.mode, 'reading');
  // A control press while restoring still captures the reader's actual position.
  const restoring = createTranscriptScroll(saved);
  assert.deepEqual(play(restoring, press('control')).last, { cancelReveal: true, capture: true });
});

test('automatic earlier loading needs upward reader intent near a loadable top', () => {
  const near = { top: 10 };
  assert.equal(play(reading(), scrolled(near)).last.navigate, undefined);
  assert.equal(play(reading(), wheel(true, near)).last.navigate, 'earlier');
  assert.equal(play(reading(), wheel(true, { top: 400 })).last.navigate, undefined);
  assert.equal(play(reading(), wheel(false, near)).last.navigate, undefined);
  assert.equal(play(reading(), wheel(true, { ...near, earlier: false })).last.navigate, undefined);
  assert.equal(play(reading(), wheel(true, { ...near, selected: true })).last.navigate, undefined);
  // An upward key admits the subsequent near-top scroll; a downward one withdraws it.
  const up = { type: 'input', device: 'key', upward: true, viewport: viewport() } as const;
  assert.equal(play(reading(), up, scrolled(near)).last.navigate, 'earlier');
  assert.equal(
    play(reading(), up, { ...up, upward: false }, scrolled(near)).last.navigate,
    undefined,
  );
  // Starting navigation consumes the intent and blocks loading until it settles.
  const navigating = play(reading(), up, navigate('earlier'));
  assert.equal(navigating.state.upward, false);
  assert.equal(play(navigating.state, wheel(true, near)).last.navigate, undefined);
  assert.equal(play(navigating.state, scrolled(near)).last.navigate, undefined);
});

test('programmatic restoration never loads earlier history or records its own scroll', () => {
  const restoring = createTranscriptScroll(saved);
  assert.equal(restoring.mode, 'restoring');
  assert.deepEqual(play(restoring, resized()).last, { scroll: 'anchor' });
  const pending = play(restoring, scrolled({ top: 0 }), { type: 'captured', position });
  assert.equal(pending.state, restoring);
  assert.deepEqual(pending.instructions, [{}, {}]);
  // Once applied (at its row/part or nearby), the supplied anchor is kept through resizes.
  const applied = play(restoring, { type: 'applied' }).state;
  assert.equal(applied.mode, 'reading');
  assert.equal(applied.anchor, saved);
  assert.deepEqual(play(applied, resized()).last, { scroll: 'anchor' });
  // Scrolls that leave it at its offset, as its own application does, record nothing.
  assert.deepEqual(play(applied, scrolled({ top: 0, bottom: 0 }, true)).last, {});
  assert.equal(play(applied, scrolled({ top: 0 }, true)).state, applied);
  // A scroll that moved the anchor (focus, another owner) records the actual position.
  assert.deepEqual(play(applied, scrolled({ top: 0 })).last, { capture: true });
});

test('reader input releases pending restoration and captures; applied restoration is kept', () => {
  const restoring = createTranscriptScroll(saved);
  const released = play(restoring, wheel(false), { type: 'captured', position });
  assert.equal(released.state.mode, 'reading');
  assert.deepEqual(released.instructions, [
    { cancelReveal: true, capture: true },
    { save: position },
  ]);
  const applied = play(restoring, { type: 'applied' }).state;
  const click = { type: 'input', device: 'pointer', upward: false, viewport: viewport() } as const;
  const kept = play(applied, click);
  assert.equal(kept.state.mode, 'reading');
  assert.equal(kept.state.anchor, saved);
  assert.deepEqual(kept.last, { cancelReveal: true });
});

test('supplied anchors restore unless navigation owns the position or nothing changed', () => {
  const supplied = play(reading(), { type: 'supplied', anchor: saved });
  assert.equal(supplied.state.mode, 'restoring');
  assert.deepEqual(supplied.last, { scroll: 'anchor' });
  assert.equal(
    play(supplied.state, {
      type: 'supplied',
      anchor: { offset: saved.offset, partId: saved.partId, entryId: saved.entryId },
    }).state,
    supplied.state,
  );
  const navigating = play(reading(), navigate('later'));
  assert.equal(play(navigating.state, { type: 'supplied', anchor: saved }).state, navigating.state);
});

test('explicit navigation keeps its captured anchor, then records the settled position', () => {
  const start = play(reading(), navigate('earlier'), {
    type: 'captured',
    position,
  });
  assert.equal(start.state.mode, 'navigating');
  assert.equal(start.state.retry, 'earlier');
  assert.deepEqual(start.instructions, [
    { capture: true, navigate: 'earlier' },
    { save: position },
  ]);
  assert.deepEqual(play(start.state, resized()).last, { scroll: 'anchor' });
  // Reader scrolling during the read updates the anchor it settles to.
  assert.deepEqual(play(start.state, scrolled()).last, { capture: true });
  assert.equal(play(start.state, wheel(false)).state.mode, 'navigating');
  const settled = {
    type: 'navigated',
    revision: start.state.revision,
    saved: null,
    viewport: viewport(),
  } as const;
  const done = play(start.state, settled);
  assert.equal(done.state.mode, 'reading');
  assert.equal(done.state.anchor, position);
  assert.deepEqual(done.last, { scroll: 'anchor', capture: true });
  // Window memory without a part does not replace the captured anchor; an exact part does.
  assert.equal(
    play(start.state, { ...settled, saved: { entryId: 'x', offset: 0 } }).state.anchor,
    position,
  );
  assert.equal(play(start.state, { ...settled, saved }).state.anchor, saved);
  assert.equal(
    play(start.state, { ...settled, revision: start.state.revision - 1 }).state,
    start.state,
  );
  const later = play(start.state, navigate('later'));
  assert.equal(play(later.state, settled).state, later.state);
});

test('the 128-row boundary reveals the hidden extra row before reading another window', () => {
  const boundary = navigate('earlier', { boundary: true });
  const row = play(reading(), boundary);
  assert.equal(row.state.earlierRow, true);
  assert.equal(row.state.mode, 'navigating');
  assert.equal(row.state.retry, 'earlier');
  assert.deepEqual(row.last, { capture: true, navigate: 'row' });
  assert.deepEqual(play(row.state, boundary).last, { capture: true, navigate: 'earlier' });
  assert.equal(play(row.state, { type: 'latest' }).state.earlierRow, false);
  // Automatic loading at the boundary also reveals the row first.
  assert.equal(play(reading(), wheel(true, { top: 10, boundary: true })).last.navigate, 'row');
  assert.deepEqual(play(reading(), navigate('later', { boundary: true })).last, {
    capture: true,
    navigate: 'later',
  });
});

test('selection/focus pins change reactively and Jump to latest clears them', () => {
  const pinned = play(reading(), { type: 'pinned', live: true, oldest: 'entry-1' }).state;
  assert.deepEqual(pinned.pins, { live: true, oldest: 'entry-1' });
  assert.equal(play(pinned, { type: 'pinned', live: true, oldest: 'entry-1' }).state, pinned);
  assert.deepEqual(play(pinned, { type: 'pinned', live: false, oldest: null }).state.pins, {
    live: false,
    oldest: null,
  });
  const latest = play(pinned, { type: 'latest' });
  assert.deepEqual(latest.state.pins, { live: false, oldest: null });
  assert.equal(latest.state.mode, 'following');
  assert.equal(latest.state.anchor, null);
  assert.equal(latest.state.retry, 'latest');
  assert.deepEqual(latest.last, { navigate: 'latest' });
  assert.deepEqual(
    play(latest.state, {
      type: 'navigated',
      revision: latest.state.revision,
      saved: null,
      viewport: viewport(),
    }).last,
    { scroll: 'end' },
  );
});

test('reading re-applies the recorded anchor, including one tracked while following', () => {
  assert.deepEqual(play(reading(), resized()).last, {});
  const recorded = play(reading(), { type: 'captured', position }).state;
  assert.deepEqual(play(recorded, resized()).last, { scroll: 'anchor' });
  // Following records no view memory but keeps the anchor for input that leaves it.
  const click = { type: 'input', device: 'pointer', upward: false, viewport: viewport() } as const;
  const left = play(createTranscriptScroll(null), { type: 'captured', position }, click);
  assert.deepEqual(left.instructions[0], { save: null });
  assert.equal(left.state.mode, 'reading');
  assert.equal(left.state.anchor, position);
  assert.deepEqual(play(left.state, resized()).last, { scroll: 'anchor' });
});

test('Find reveal owns position until reader input cancels it', () => {
  const navigating = play(reading(), navigate('earlier'));
  const revealing = play(navigating.state, { type: 'reveal' }).state;
  assert.equal(revealing.mode, 'revealing');
  assert.deepEqual(play(revealing, resized()).last, {});
  // The reveal supersedes a pending navigation settlement.
  assert.equal(
    play(revealing, {
      type: 'navigated',
      revision: navigating.state.revision,
      saved: null,
      viewport: viewport(),
    }).state,
    revealing,
  );
  // Find's reveal scroll is recorded and then kept through resizes; input still captures.
  const recorded = play(revealing, scrolled(), { type: 'captured', position });
  assert.equal(recorded.instructions[0].capture, true);
  assert.equal(recorded.state.mode, 'revealing');
  assert.deepEqual(recorded.last, { save: position });
  assert.deepEqual(play(recorded.state, resized()).last, { scroll: 'anchor' });
  assert.deepEqual(play(recorded.state, wheel(false)).last, { cancelReveal: true, capture: true });
  const cancelled = play(revealing, wheel(false));
  assert.equal(cancelled.state.mode, 'reading');
  assert.deepEqual(cancelled.last, { cancelReveal: true, capture: true });
  assert.equal(play(reading(), wheel(true)).last.cancelReveal, true);
});

test('following tracks its anchor through its own scrolls and holds it for a selection', () => {
  const following = createTranscriptScroll(null);
  // Its own end scroll is held but still records the anchor input leaving it will keep.
  assert.deepEqual(play(following, scrolled({ bottom: 0 }, true)).last, { capture: true });
  const tracked = play(following, { type: 'captured', position }).state;
  assert.equal(tracked.mode, 'following');
  assert.deepEqual(play(tracked, resized()).last, { scroll: 'end' });
  // Selected text, made without input that leaves following, stays where the reader selected it.
  assert.deepEqual(play(tracked, resized({ selected: true })).last, { scroll: 'anchor' });
  assert.deepEqual(play(tracked, resized({ atLatest: false })).last, { scroll: 'anchor' });
});

test('navigation settlement ends the upward intent that admitted it', () => {
  const near = { top: 10 };
  const loading = play(reading(), wheel(true, near));
  assert.equal(loading.last.navigate, 'earlier');
  // Upward input during the read does not admit automatic loading after it settles.
  const during = play(loading.state, wheel(true, near)).state;
  assert.equal(during.upward, true);
  const settled = play(during, {
    type: 'navigated',
    revision: during.revision,
    saved: null,
    viewport: viewport(near),
  }).state;
  assert.equal(settled.upward, false);
  assert.equal(play(settled, scrolled(near)).last.navigate, undefined);
});

test('Retry history repeats the failed read instead of revealing the boundary row', () => {
  const retry = {
    type: 'navigate',
    direction: 'earlier',
    retry: true,
    viewport: viewport({ boundary: true }),
  } as const;
  const repeated = play(reading(), retry);
  assert.equal(repeated.state.earlierRow, false);
  assert.deepEqual(repeated.last, { capture: true, navigate: 'earlier' });
});
