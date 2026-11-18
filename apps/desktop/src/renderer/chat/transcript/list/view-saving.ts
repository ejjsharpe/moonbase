import { useContext, useEffect, useEffectEvent, type RefObject } from 'react';
import { RegistryContext } from '@effect/atom-react';
import type { LegendListRef } from '@legendapp/list/react';
import type { TranscriptView as SavedView, TranscriptViewAnchor } from '@moonbase/application/chat';
import { useTranscript } from '../transcript-context.ts';
import { findReadingAnchor } from './list-items.ts';

/**
 * The view with the reader's anchor saved (null while following); the same view when the anchor
 * is unchanged. The list lays rows out at fractional positions but scrolls in whole device pixels,
 * so a restored anchor reports its offset up to a device pixel off. An offset that moved less than
 * a device pixel (at least a CSS pixel) is the same position and keeps the saved anchor; saving it
 * would drift the anchor on every reopen. `devicePixel` is the device pixel's size in CSS pixels.
 */
export const saveReadingAnchor =
  (anchor: TranscriptViewAnchor | null, devicePixel: number) =>
  (view: SavedView): SavedView => {
    const saved = view.anchor;
    if (anchor === saved) return view;
    if (
      anchor &&
      saved &&
      anchor.key === saved.key &&
      Math.abs(anchor.offset - saved.offset) < Math.max(1, devicePixel)
    )
      return view;
    return { anchor, expanded: view.expanded };
  };

/** Read on each save, since a window can move between displays. */
const readDevicePixel = () => 1 / window.devicePixelRatio;

/**
 * Saves where the reader is once scrolling ends: the list's first visible row and its offset, or
 * null while following. Scrolling publishes nothing per event, and a save after the view's chat
 * was replaced lands nowhere. Returns `save`, which paging calls first, so the application knows
 * whether the reader still follows while a page reads.
 */
export function useViewSaving({
  list,
  ready,
  holding,
}: {
  list: RefObject<LegendListRef | null>;
  /** The list placed its dataset. */
  ready: boolean;
  /** The list holds a restored anchor in place, which is then where the reader is. */
  holding: () => boolean;
}) {
  const { view, act, selection, target } = useTranscript();
  const registry = useContext(RegistryContext);
  const save = () => {
    const ref = list.current;
    if (!ref || !ready || holding()) return;
    const { view: saved, rows, loading, later } = registry.get(view.transcript);
    // A restoration still reading its anchor's history saves nothing over it.
    if (saved.anchor && loading && !rows.some((row) => row.key === saved.anchor!.key)) return;
    let anchor: TranscriptViewAnchor | null = null;
    if (!ref.getState().isFollowingEnd || later) {
      // The list reports its first visible item; the anchor names one of its stored rows.
      const visible = ref.anchorVisibleContent({ hold: false });
      const node = ref.getScrollableNode();
      const itemKeys = registry.get(view.itemKeys);
      const found =
        visible &&
        findReadingAnchor(registry.get(view.items), visible, {
          measure: (key) => ref.anchorVisibleContent({ key, hold: false })?.offset,
          // From where the row is on screen, so the offset reads as the restore places it.
          rowTop: (key) => {
            const item = itemKeys.get(key);
            const offset =
              item === undefined
                ? undefined
                : ref.anchorVisibleContent({ key: item, hold: false })?.offset;
            const row = node?.querySelector(`[data-transcript-row="${CSS.escape(key)}"]`);
            // A row in a folded run isn't shown, so it has no place on screen.
            return offset === undefined || !row || !row.getClientRects().length
              ? undefined
              : offset - (node!.getBoundingClientRect().top - row.getBoundingClientRect().top);
          },
        });
      if (!found) return;
      anchor = found;
    }
    void act(selection.updateTranscriptView(target, saveReadingAnchor(anchor, readDevicePixel())));
  };
  const saveOnScrollEnd = useEffectEvent(save);
  useEffect(() => {
    const node = list.current?.getScrollableNode();
    const listener = () => saveOnScrollEnd();
    node?.addEventListener('scrollend', listener);
    return () => node?.removeEventListener('scrollend', listener);
  }, [list]);
  return save;
}
