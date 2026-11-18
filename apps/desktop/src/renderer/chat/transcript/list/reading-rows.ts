import { useContext, useEffect, useMemo, useState, type RefObject } from 'react';
import { RegistryContext } from '@effect/atom-react';
import { getEntryRowKey, type TranscriptRow } from '@moonbase/application/chat';
import type { ChatTranscriptMatch, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { isReadingNodePinned, subscribeReadingChanges } from '../reading-pin.ts';
import type { TranscriptView } from '../transcript-view.ts';

type ReadingRows = {
  /** The rows a noncollapsed selection in the transcript starts and ends in. */
  selected: readonly [string, string] | null;
  selecting: boolean;
  focused: string | null;
};
const notReading: ReadingRows = { selected: null, selecting: false, focused: null };
/** The row a node is in; a run's line counts as its first row. */
const findRowKeyOf = (node: Node | null | undefined) => {
  const found = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
    '[data-transcript-row], [data-transcript-run]',
  );
  return found?.dataset.transcriptRow ?? found?.dataset.transcriptRun ?? null;
};

/**
 * Where the reader's selection and focus are in the transcript, updated on every change. Whether
 * they are in the live response goes to the view, which then holds the response they are reading.
 */
export function useReadingRows(scroller: RefObject<HTMLElement | null>, view: TranscriptView) {
  const registry = useContext(RegistryContext);
  const [reading, setReading] = useState(notReading);
  useEffect(
    () =>
      subscribeReadingChanges(() => {
        const node = scroller.current;
        const selection = window.getSelection();
        const range =
          node && selection && !selection.isCollapsed && selection.rangeCount
            ? selection.getRangeAt(0)
            : null;
        const selecting = !!node && !!range && range.intersectsNode(node);
        const start = selecting ? findRowKeyOf(range!.startContainer) : null,
          end = selecting ? findRowKeyOf(range!.endContainer) : null;
        const next: ReadingRows = {
          selected: start || end ? [start ?? end!, end ?? start!] : null,
          selecting,
          focused: node?.contains(document.activeElement)
            ? findRowKeyOf(document.activeElement)
            : null,
        };
        setReading((previous) => (areJsonValuesEqual(previous, next) ? previous : next));
        registry.set(
          view.readingLive,
          isReadingNodePinned(node?.querySelector<HTMLElement>('[data-transcript-live]') ?? null),
        );
      }),
    [scroller, registry, view],
  );
  return reading;
}

/**
 * The rows kept mounted while scrolled away: the rows a selection spans, the focused row, the
 * image viewer's row and the active Find match's row. Unmounting them would lose the reader's
 * selection or focus, the viewer's return target or the match being revealed.
 */
export function useMountedRowKeys(
  rows: readonly TranscriptRow[],
  reading: ReadingRows,
  imageSource: ChatTranscriptSource | null,
  findActive: ChatTranscriptMatch | null,
) {
  const keys = new Set<string>();
  if (reading.selected) {
    const [first, last] = reading.selected
      .map((key) => rows.findIndex((row) => row.key === key))
      .sort((a, b) => a - b);
    if (first! >= 0) for (let index = first!; index <= last!; index++) keys.add(rows[index]!.key);
  }
  if (reading.focused) keys.add(reading.focused);
  if (imageSource) {
    const row = rows.find((row) => areJsonValuesEqual(row.entry.transcript?.source, imageSource));
    if (row) keys.add(row.key);
  }
  if (findActive) keys.add(getEntryRowKey(findActive.source.entryId));
  const joined = [...keys].join('\n');
  return useMemo(() => (joined ? joined.split('\n') : []), [joined]);
}
