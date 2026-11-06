import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';

export type ViewSaver = ReturnType<typeof createViewSaver>;

/**
 * Saves the reading anchor (null while following) to view memory for one conversation. The
 * transcript saves when scrolling ends, so scrolling publishes nothing per event. A save never
 * lands in another conversation: after a switch it is dropped.
 *
 * The list lays rows out at fractional positions but scrolls in whole device pixels, so a
 * restored anchor reports its offset up to a device pixel off. An offset that moved less than a
 * device pixel (at least a CSS pixel) is the same position and keeps the saved anchor; saving it
 * would drift the anchor on every reopen. `readDevicePixel` is the device pixel's size in CSS
 * pixels, read on each save since a window can move between displays.
 */
export function createViewSaver(
  controller: Pick<ChatController, 'getSnapshot' | 'setTranscriptView'>,
  readDevicePixel: () => number,
) {
  const conversation = JSON.stringify(controller.getSnapshot().selected);
  return {
    save(anchor: TranscriptViewAnchor | null) {
      const snapshot = controller.getSnapshot();
      if (JSON.stringify(snapshot.selected) !== conversation) return;
      const { view } = snapshot.transcript;
      const saved = view.anchor;
      if (anchor === saved) return;
      if (
        anchor &&
        saved &&
        anchor.key === saved.key &&
        Math.abs(anchor.offset - saved.offset) < Math.max(1, readDevicePixel())
      )
        return;
      controller.setTranscriptView({ anchor, expanded: view.expanded });
    },
  };
}
