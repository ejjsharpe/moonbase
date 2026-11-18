import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptView } from '@moonbase/application/chat';
import { saveReadingAnchor } from '../src/renderer/chat/transcript/list/view-saving.ts';

const at = (entryId: string, offset = 0) => ({ key: 'entry:' + entryId, offset });
/** Saves each anchor in turn, returning the anchors that changed the view. */
function saveAll(anchors: (ReturnType<typeof at> | null)[], devicePixel: () => number = () => 1) {
  let view: TranscriptView = { anchor: null, expanded: ['kept'] };
  const writes: TranscriptView[] = [];
  for (const anchor of anchors) {
    const next = saveReadingAnchor(anchor, devicePixel())(view);
    if (next !== view) writes.push((view = next));
  }
  return writes;
}

test('a save changes the view only for a changed anchor, and keeps expansions', () => {
  const writes = saveAll([at('a'), { offset: 0, key: 'entry:a' }, at('a', 4), null, null]);
  assert.deepEqual(
    writes.map((view) => view.anchor),
    [at('a'), at('a', 4), null],
  );
  assert(writes.every((view) => view.expanded[0] === 'kept'));
});

test('an offset that moved less than a device pixel keeps the saved anchor', () => {
  let devicePixel = 1;
  const anchors = [at('a', 52), at('a', 51.625), at('a', 52.5), at('a', 53), at('b', 53.25)];
  // A restore scrolled to a whole pixel reports a fraction off; it isn't a new position.
  assert.deepEqual(
    saveAll(anchors).map((view) => view.anchor),
    [at('a', 52), at('a', 53), at('b', 53.25)],
  );
  // Zoomed out, a device pixel is larger than a CSS pixel.
  const zoomed = saveAll([...anchors, at('b', 54.25)], () => (devicePixel = 1.25));
  assert.equal(devicePixel, 1.25);
  assert.deepEqual(zoomed.at(-1)!.anchor, at('b', 53.25));
});
