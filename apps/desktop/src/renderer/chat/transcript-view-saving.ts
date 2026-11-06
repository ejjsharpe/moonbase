import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';

export type ViewSaver = ReturnType<typeof createViewSaver>;

/**
 * Saves the reading anchor (null while following) to view memory for one conversation. The
 * transcript saves when scrolling ends, so scrolling publishes nothing per event. A save never
 * lands in another conversation: after a switch it is dropped.
 */
export function createViewSaver(
  controller: Pick<ChatController, 'getSnapshot' | 'setTranscriptView'>,
) {
  const conversation = JSON.stringify(controller.getSnapshot().selected);
  return {
    save(anchor: TranscriptViewAnchor | null) {
      const snapshot = controller.getSnapshot();
      if (JSON.stringify(snapshot.selected) !== conversation) return;
      const { view } = snapshot.transcript;
      if (areJsonValuesEqual(anchor, view.anchor)) return;
      controller.setTranscriptView({ anchor, expanded: view.expanded });
    },
  };
}
