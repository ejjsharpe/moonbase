import { createContext } from 'react';
import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';

/** A scroll-captured reading anchor is saved to view memory once scrolling rests this long. */
export const viewSaveDelayMs = 150;

export type ViewSaver = ReturnType<typeof createViewSaver>;
/** Lets rows write the queued anchor before they read and rewrite the view. */
export const TranscriptViewSaver = createContext<Pick<ViewSaver, 'flush'>>({ flush() {} });

/**
 * Saves the reading anchor to view memory for one conversation. Leaving following saves at once,
 * so the application stops following; later scroll adjustments wait until scrolling rests, so
 * scrolling publishes nothing per event. Navigation flushes a queued save and jumping to latest
 * drops it. A queued save never lands in another conversation: switching drops it.
 */
export function createViewSaver(
  controller: Pick<ChatController, 'getSnapshot' | 'setTranscriptView'>,
  delayMs = viewSaveDelayMs,
) {
  const conversation = JSON.stringify(controller.getSnapshot().selected);
  let pending: { anchor: TranscriptViewAnchor | null } | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    deferred = false,
    own: TranscriptViewAnchor | null | undefined,
    seen: TranscriptViewAnchor | null | undefined;
  const isCurrent = () => JSON.stringify(controller.getSnapshot().selected) === conversation;
  const write = (anchor: TranscriptViewAnchor | null) => {
    const { view } = controller.getSnapshot().transcript;
    // Following saves no anchor on each update; only a change needs a write.
    if (!anchor && !view.anchor) return;
    own = anchor;
    controller.setTranscriptView({ anchor, expanded: view.expanded });
  };
  const cancel = () => {
    clearTimeout(timer);
    pending = null;
  };
  const flush = () => {
    const queued = pending;
    cancel();
    if (queued && isCurrent()) write(queued.anchor);
  };
  return {
    save(anchor: TranscriptViewAnchor | null) {
      const leavingFollowing = !!anchor && !controller.getSnapshot().transcript.view.anchor;
      if (!deferred || leavingFollowing) {
        cancel();
        write(anchor);
        return;
      }
      pending = { anchor };
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    /** Runs `work` with its saves deferred until scrolling rests. */
    deferring(work: () => void) {
      deferred = true;
      try {
        work();
      } finally {
        deferred = false;
      }
    },
    flush,
    cancel,
    /**
     * Records an anchor the application supplied; true when it differs by value from this view's
     * own last save and the last anchor supplied, so it should be applied. A rewrite of the same
     * view (a disclosure toggle) or an echo of this view's save is not.
     */
    receive(anchor: TranscriptViewAnchor) {
      const fresh =
        !(own !== undefined && areJsonValuesEqual(anchor, own)) &&
        !(seen !== undefined && areJsonValuesEqual(anchor, seen));
      seen = anchor;
      return fresh;
    },
  };
}
