import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isReadingNodePinned,
  subscribeReadingChanges,
} from '../src/renderer/chat/transcript/reading-pin.ts';

/** A document that records which listeners it gains and loses, and a selection to set. */
function installDocument() {
  const added: string[] = [],
    removed: string[] = [];
  const target = new EventTarget();
  let range: { intersectsNode(node: unknown): boolean } | null = null;
  Object.assign(globalThis, {
    document: {
      activeElement: null,
      addEventListener(type: string, listener: EventListener) {
        added.push(type);
        target.addEventListener(type, listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        removed.push(type);
        target.removeEventListener(type, listener);
      },
      dispatchEvent: (event: Event) => target.dispatchEvent(event),
    },
    window: {
      getSelection: () =>
        range
          ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => range }
          : { isCollapsed: true, rangeCount: 0 },
    },
  });
  return {
    added,
    removed,
    select(node: unknown) {
      range = { intersectsNode: (other) => other === node };
      document.dispatchEvent(new Event('selectionchange'));
    },
  };
}

test('reading pins share one set of document listeners, released with the last subscriber', () => {
  const page = installDocument();
  const node = { contains: () => false } as unknown as HTMLElement;
  let first = 0,
    second = 0;
  const releaseFirst = subscribeReadingChanges(() => first++);
  const releaseSecond = subscribeReadingChanges(() => second++);
  assert.deepEqual(page.added, ['selectionchange', 'focusin', 'focusout']);
  page.select(node);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(isReadingNodePinned(node), true);
  releaseFirst();
  assert.deepEqual(page.removed, []);
  releaseSecond();
  assert.deepEqual(page.removed, ['selectionchange', 'focusin', 'focusout']);
});
