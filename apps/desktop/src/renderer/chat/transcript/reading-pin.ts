import { useCallback, useSyncExternalStore, type RefObject } from 'react';

/**
 * Reading pins: whether the reader's focus is inside a node, or a noncollapsed selection
 * intersects it. Rendering holds pinned content still. One shared set of document listeners
 * serves every consumer, and a consumer is notified only when its own pin changes.
 */
export const readingPin = { focused: 1, selected: 2 } as const;

type Watch = { node: () => HTMLElement | null; pin: number; notify(): void };
const watches = new Set<Watch>();
const changeListeners = new Set<() => void>();
const pins = new WeakMap<HTMLElement, number>();

function readPin(node: HTMLElement | null, range: Range | null) {
  if (!node) return 0;
  let pin = 0;
  if (node.contains(document.activeElement)) pin |= readingPin.focused;
  if (range?.intersectsNode(node)) pin |= readingPin.selected;
  return pin;
}

function readRange() {
  const selection = window.getSelection();
  return selection && !selection.isCollapsed && selection.rangeCount > 0
    ? selection.getRangeAt(0)
    : null;
}

function updatePins() {
  const range = readRange();
  for (const watch of watches) {
    const node = watch.node();
    const pin = readPin(node, range);
    if (node) pins.set(node, pin);
    if (pin === watch.pin) continue;
    watch.pin = pin;
    watch.notify();
  }
  for (const listener of changeListeners) listener();
}

const events = ['selectionchange', 'focusin', 'focusout'] as const;
function retainListeners() {
  if (watches.size + changeListeners.size === 1)
    for (const event of events) document.addEventListener(event, updatePins);
}
function releaseListeners() {
  if (!watches.size && !changeListeners.size)
    for (const event of events) document.removeEventListener(event, updatePins);
}

/** Reads a node's current pin without subscribing. */
export function isReadingNodePinned(node: HTMLElement | null) {
  return readPin(node, readRange()) !== 0;
}

/** Calls `listener` after any focus or selection change, once all pins are updated. */
export function subscribeReadingChanges(listener: () => void) {
  changeListeners.add(listener);
  retainListeners();
  return () => {
    changeListeners.delete(listener);
    releaseListeners();
  };
}

/** The pin of `ref`'s node (a `readingPin` bit set); `enabled: false` stops listening. */
export function useReadingPin(ref: RefObject<HTMLElement | null>, enabled = true) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!enabled) return () => {};
      const watch: Watch = { node: () => ref.current, pin: 0, notify };
      watch.pin = readPin(ref.current, readRange());
      if (ref.current) pins.set(ref.current, watch.pin);
      watches.add(watch);
      retainListeners();
      if (watch.pin) notify();
      return () => {
        watches.delete(watch);
        releaseListeners();
      };
    },
    [ref, enabled],
  );
  return useSyncExternalStore(subscribe, () =>
    enabled && ref.current ? (pins.get(ref.current) ?? 0) : 0,
  );
}
