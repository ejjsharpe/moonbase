import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';
import type { ChatTranscriptMatch, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { getTranscriptDisclosureId } from '../../chat/transcript-source.ts';
import { TranscriptViewSaver } from './transcript-view-saving.ts';
import { useRowState } from './transcript-row-state.ts';

/** An anchor's identity without its viewport offset. */
export function getAnchorKey(anchor: TranscriptViewAnchor) {
  return JSON.stringify({ ...anchor, offset: 0 });
}

/**
 * The view-memory expansion ID of disclosure `id` in a row: null while it is being computed, and
 * `failed` when it can't be, so the disclosure shows expanded.
 */
function useExpansionId(entryId: string, id: string) {
  const disclosure = useMemo(() => getTranscriptDisclosureId(entryId, id), [entryId, id]);
  const [resolved, setResolved] = useState<{ disclosure: typeof disclosure; value: string } | null>(
    null,
  );
  const [failed, setFailed] = useState<typeof disclosure | null>(null);
  useEffect(() => {
    if (typeof disclosure === 'string') return;
    let active = true;
    void disclosure.then(
      (value) => {
        if (active) setResolved({ disclosure, value });
      },
      () => {
        if (active) setFailed(disclosure);
      },
    );
    return () => {
      active = false;
    };
  }, [disclosure]);
  let expansion: string | null = null;
  if (typeof disclosure === 'string') expansion = disclosure;
  else if (resolved?.disclosure === disclosure) expansion = resolved.value;
  return { expansion, failed: failed === disclosure };
}

/**
 * Writes one expansion into view memory. A reader's press saves their position first (see
 * `TranscriptViewSaver`), so this rewrite keeps where they are.
 */
function setExpansion(controller: ChatController, expansion: string, open: boolean) {
  const { view } = controller.getSnapshot().transcript;
  if (view.expanded.includes(expansion) === open) return;
  controller.setTranscriptView({
    ...view,
    expanded: open ? [...view.expanded, expansion] : view.expanded.filter((id) => id !== expansion),
  });
}

/** Rows' view memory, for disclosures inside rendered content such as a long code block. */
export type RowExpansions = {
  entryId: string;
  partId: string;
  expandedIds: readonly string[];
  controller: ChatController;
};
export const RowExpansionContext = createContext<RowExpansions | null>(null);
/**
 * A disclosure remembered in view memory, so it stays as the reader left it while its row is
 * scrolled away and unmounted. Outside a transcript row it is local state.
 */
export function useRememberedExpansion(id: string | null) {
  const row = useContext(RowExpansionContext);
  const saver = useContext(TranscriptViewSaver);
  const { expansion, failed } = useExpansionId(
    row?.entryId ?? '',
    `${row?.partId ?? ''}:${id ?? ''}`,
  );
  const [local, setLocal] = useState(false);
  if (!row || id === null) return { open: local, setOpen: setLocal };
  return {
    open: failed || (expansion !== null && row.expandedIds.includes(expansion)),
    setOpen: (open: boolean) => {
      if (!expansion) return;
      saver.flush();
      setExpansion(row.controller, expansion, open);
    },
  };
}

/**
 * A remembered disclosure: expanded when its view memory says so, and while the reading anchor or
 * active Find match is inside it unless the reader explicitly collapsed it for that anchor/match.
 * Find revealing a match inside it again (returning to the match) expands it again. The result
 * controls a Base UI Collapsible.
 */
export function useDisclosure({
  entryId,
  id,
  partIds,
  source,
  expandedIds,
  anchorKey,
  match,
  revealing,
  controller,
}: {
  entryId: string;
  id: string;
  partIds: readonly string[];
  source: ChatTranscriptSource;
  /** View memory of expanded disclosure IDs. */
  expandedIds: readonly string[];
  /** The reading anchor inside this disclosure, when no Find match is active. */
  anchorKey: string | null;
  /** The active Find match, when it is inside this disclosure. */
  match: ChatTranscriptMatch | null;
  /** Find is revealing the active match: it was just moved to, and no reader input ended that. */
  revealing: boolean;
  controller: ChatController;
}) {
  const saver = useContext(TranscriptViewSaver);
  const { expansion, failed: disclosureError } = useExpansionId(entryId, id);
  const revealKey = match ? JSON.stringify(match) : anchorKey;
  /** The reveal the reader folded again; kept while the row is scrolled away. */
  const [collapsedReveal, setCollapsedReveal] = useRowState<string | null>(
    expansion && 'collapsed-reveal:' + expansion,
    null,
  );
  // The fold lasts while its reveal does. It ends once nothing here is revealed, and when Find
  // reveals a match here again: a row scrolled away may not have rendered the reveal moving on.
  if (collapsedReveal !== null && (revealKey === null || (match && revealing)))
    setCollapsedReveal(null);
  /** The state the reader saw when pressing, before reading capture can reveal this disclosure. */
  const pressedOpen = useRef<boolean | null>(null);
  const open =
    disclosureError ||
    (expansion !== null && expandedIds.includes(expansion)) ||
    (revealKey !== null && collapsedReveal !== revealKey);
  const toggle = () => {
    if (!expansion) return;
    const collapse = pressedOpen.current ?? open;
    pressedOpen.current = null;
    // Save the reader's position before reading it (and before the view is rewritten), so a fold
    // is recorded against the anchor where they are.
    saver.flush();
    const { view, find } = controller.getSnapshot().transcript;
    const active = find.active;
    const inside =
      active && areJsonValuesEqual(active.source, source) && partIds.includes(active.partId)
        ? active
        : null;
    if (collapse && inside) {
      // Folding the match is reader input: it ends the reveal, which would expand it again.
      controller.cancelFindReveal();
      setCollapsedReveal(JSON.stringify(inside));
    } else if (collapse && !active && view.anchor?.partId && partIds.includes(view.anchor.partId))
      setCollapsedReveal(getAnchorKey(view.anchor));
    setExpansion(controller, expansion, !collapse);
  };
  return {
    open,
    disclosureError,
    disabled: !expansion,
    /** The requested state is ignored: a press toggles what the reader saw when pressing. */
    onOpenChange: toggle,
    triggerProps: {
      onPointerDown: () => {
        pressedOpen.current = open;
      },
      onPointerCancel: () => {
        pressedOpen.current = null;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!event.repeat) pressedOpen.current = [' ', 'Enter'].includes(event.key) ? open : null;
      },
    },
  };
}
