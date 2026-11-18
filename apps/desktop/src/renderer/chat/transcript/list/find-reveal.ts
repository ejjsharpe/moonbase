import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { RegistryContext } from '@effect/atom-react';
import type { LegendListRef } from '@legendapp/list/react';
import { getEntryRowKey } from '@moonbase/application/chat';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { revealFindMatch } from '../transcript-geometry.ts';
import { useTranscript } from '../transcript-context.ts';

/**
 * Scrolls a newly revealed Find match into view, or one a jump just placed: scrolling to its row
 * releases following, then the match itself is revealed inside it. A match rendered later is
 * revealed by its part. Returns the list's `onItemSizeChanged`, which holds a revealing match in
 * view while its row grows (its part loading or unfolding): the list holds the row's top, not the
 * match inside it. Reader input ends revealing.
 */
export function useFindReveal({
  list,
  ready,
  dataset,
  match,
  revealing,
}: {
  list: RefObject<LegendListRef | null>;
  ready: boolean;
  dataset: number;
  match: ChatTranscriptMatch | null;
  revealing: boolean;
}) {
  const { view } = useTranscript();
  const registry = useContext(RegistryContext);
  /** The list item holding a match's row. */
  const findItem = (match: ChatTranscriptMatch) => {
    const key = getEntryRowKey(match.source.entryId);
    return registry.get(view.itemKeys).get(key) ?? key;
  };
  const reveal = useEffectEvent((ref: LegendListRef, match: ChatTranscriptMatch) => {
    void ref.scrollToKey({ key: findItem(match), animated: false }).then(() => {
      if (registry.get(view.transcript).dataset === dataset) revealFindMatch(ref);
    });
  });
  useLayoutEffect(() => {
    const ref = list.current;
    if (!match || !revealing || !ref || !ready) return;
    reveal(ref, match);
  }, [match, revealing, dataset, list, ready]);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return ({ itemKey }: { itemKey: string }) => {
    const { match, revealing } = registry.get(view.rows.activeFind);
    if (!revealing || !match || findItem(match) !== itemKey) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (list.current && registry.get(view.rows.activeFind).revealing)
        revealFindMatch(list.current);
    });
  };
}
