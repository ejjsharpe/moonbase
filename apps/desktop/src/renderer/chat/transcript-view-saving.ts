import { createContext } from 'react';
import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';

export type ViewSaver = ReturnType<typeof createViewSaver>;
/** Lets rows save the current reading position before they read and rewrite the view. */
export const TranscriptViewSaver = createContext<{ flush(): void }>({ flush() {} });

/**
 * Saves the reading anchor (null while following) to view memory for one conversation. The
 * transcript saves when scrolling ends, so scrolling publishes nothing per event. A save never
 * lands in another conversation: after a switch it is dropped.
 */
export function createViewSaver(
  controller: Pick<ChatController, 'getSnapshot' | 'setTranscriptView'>,
) {
  const conversation = JSON.stringify(controller.getSnapshot().selected);
  let own: TranscriptViewAnchor | null | undefined, seen: TranscriptViewAnchor | null | undefined;
  return {
    save(anchor: TranscriptViewAnchor | null) {
      const snapshot = controller.getSnapshot();
      if (JSON.stringify(snapshot.selected) !== conversation) return;
      const { view } = snapshot.transcript;
      if (areJsonValuesEqual(anchor, view.anchor)) return;
      own = anchor;
      controller.setTranscriptView({ anchor, expanded: view.expanded });
    },
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
