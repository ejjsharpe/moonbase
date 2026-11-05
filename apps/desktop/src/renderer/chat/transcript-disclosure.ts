import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatController, TranscriptViewAnchor } from '@moonbase/application/chat';
import type { ChatTranscriptMatch, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { getTranscriptDisclosureId } from '../../chat/transcript-source.ts';

/** An anchor's identity without its viewport offset. */
export function getAnchorKey(anchor: TranscriptViewAnchor) {
  return JSON.stringify({ ...anchor, offset: 0 });
}

/**
 * A remembered disclosure: expanded when its view memory says so, and while the reading anchor or
 * active Find match is inside it unless the reader explicitly collapsed it for that anchor/match.
 * The result controls a Base UI Collapsible.
 */
export function useDisclosure({
  entryId,
  id,
  partIds,
  source,
  expandedIds,
  anchorKey,
  match,
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
  controller: ChatController;
}) {
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
  const disclosureError = failed === disclosure;
  const revealKey = match ? JSON.stringify(match) : anchorKey;
  const [collapsedReveal, setCollapsedReveal] = useState<string | null>(null);
  /** The state the reader saw when pressing, before reading capture can reveal this disclosure. */
  const pressedOpen = useRef<boolean | null>(null);
  if (revealKey === null && collapsedReveal !== null) setCollapsedReveal(null);
  const open =
    disclosureError ||
    (expansion !== null && expandedIds.includes(expansion)) ||
    (revealKey !== null && collapsedReveal !== revealKey);
  const toggle = () => {
    if (!expansion) return;
    const collapse = pressedOpen.current ?? open;
    pressedOpen.current = null;
    const { view, find } = controller.getSnapshot().transcript;
    const active = find.active;
    const inside =
      active &&
      JSON.stringify(active.source) === JSON.stringify(source) &&
      partIds.includes(active.partId)
        ? active
        : null;
    if (collapse && inside) setCollapsedReveal(JSON.stringify(inside));
    else if (collapse && !active && view.anchor?.partId && partIds.includes(view.anchor.partId))
      setCollapsedReveal(getAnchorKey(view.anchor));
    controller.setTranscriptView({
      ...view,
      expanded: collapse
        ? view.expanded.filter((id) => id !== expansion)
        : [...view.expanded, expansion],
    });
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
