import type { Comparison, FileDocument, FileView } from '@moonbase/contracts/workspace';
import type { CheckoutView } from '../recovery/recovery-layout.ts';

export type OpenOptions = {
  view?: FileView;
  /** `preview` opens in the checkout's one preview tab; `keep` keeps a preview tab open. */
  intent?: 'preview' | 'keep';
  /** Checked once the file is read; once false, the open is abandoned. */
  current?: () => boolean;
};

/** A conflict's comparison: what is on disk now against the edits. */
export const conflictComparison = (disk: FileDocument): Comparison => ({
  original: disk.text,
  working: disk,
  title: 'Disk versus your edits',
});

/**
 * Places an opened file in its checkout's view, which it changes, as the active tab: a file
 * without a tab gets one after the active tab, replacing a clean preview tab when it opens as the
 * preview. Returns the preview tab it closed and whether it opened a tab.
 */
export function placeOpenedFile(
  view: CheckoutView,
  path: string,
  intent: OpenOptions['intent'],
  isClean: (path: string) => boolean,
  openedClean: boolean,
) {
  let closedPreview: string | undefined,
    opened = false;
  if (!view.openFiles.includes(path)) {
    const previous = view.preview;
    if (intent === 'preview' && previous && previous !== path && isClean(previous)) {
      view.openFiles = view.openFiles.filter((open) => open !== previous);
      closedPreview = previous;
    }
    view.openFiles.splice(view.openFiles.indexOf(view.active) + 1, 0, path);
    opened = true;
    if (intent === 'preview' && openedClean) view.preview = path;
  }
  if (intent === 'keep') view.preview = view.preview === path ? null : view.preview;
  view.active = path;
  return { closedPreview, opened };
}
