import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ChatController } from '@moonbase/application/chat';
import type { ChatTranscriptMatch, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { getTranscriptDisclosureId } from '../../chat/transcript-source.ts';

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

/** Writes one expansion into view memory. */
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
  const { expansion, failed } = useExpansionId(
    row?.entryId ?? '',
    `${row?.partId ?? ''}:${id ?? ''}`,
  );
  const [local, setLocal] = useState(false);
  if (!row || id === null) return { open: local, setOpen: setLocal };
  return {
    open: failed || (expansion !== null && row.expandedIds.includes(expansion)),
    setOpen: (open: boolean) => {
      if (expansion) setExpansion(row.controller, expansion, open);
    },
  };
}

/**
 * A remembered disclosure: expanded when its view memory says so, and while the active Find match
 * is inside it unless the reader collapsed it for that match. Find revealing the match again
 * (returning to it) expands it again. The result controls a Base UI Collapsible.
 */
export function useDisclosure({
  entryId,
  id,
  partIds,
  source,
  expandedIds,
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
  /** The active Find match, when it is inside this disclosure. */
  match: ChatTranscriptMatch | null;
  /** Find is revealing the active match: it was just moved to, and no reader input ended that. */
  revealing: boolean;
  controller: ChatController;
}) {
  const { expansion, failed: disclosureError } = useExpansionId(entryId, id);
  const revealKey = match ? JSON.stringify(match) : null;
  /** The match the reader folded again. The active match's row stays mounted, so this does too. */
  const [collapsedReveal, setCollapsedReveal] = useState<string | null>(null);
  // The fold lasts while its match is active. It ends once no match is here, and when Find reveals
  // the match again.
  if (collapsedReveal !== null && (revealKey === null || revealing)) setCollapsedReveal(null);
  const open =
    disclosureError ||
    (expansion !== null && expandedIds.includes(expansion)) ||
    (revealKey !== null && collapsedReveal !== revealKey);
  const toggle = () => {
    if (!expansion) return;
    const collapse = open;
    const active = controller.getSnapshot().transcript.find.active;
    const inside =
      active && areJsonValuesEqual(active.source, source) && partIds.includes(active.partId)
        ? active
        : null;
    if (collapse && inside) {
      // Folding the match is reader input: it ends the reveal, which would expand it again.
      controller.cancelFindReveal();
      setCollapsedReveal(JSON.stringify(inside));
    }
    setExpansion(controller, expansion, !collapse);
  };
  return {
    open,
    disclosureError,
    disabled: !expansion,
    onOpenChange: toggle,
  };
}

/**
 * Which tool calls have their card open. A call and its output are separate rows: the call's row
 * publishes whether it is open, and the output's row, which shows no line of its own while the
 * call's entry is retained, opens with it. An output open on its own (Find revealing a match in
 * it) shows its call's card open too, and folding the call folds it. Keys are `entryId\npartId` of
 * the call.
 */
export type OpenCalls = {
  isOpen(keys: readonly string[]): boolean;
  set(keys: readonly string[], open: boolean): void;
  /** Publishes an output row's own disclosure under its calls' keys; null when it unmounts. */
  setOutput(id: string, keys: readonly string[], output: OutputDisclosure | null): void;
  isOutputOpen(keys: readonly string[]): boolean;
  foldOutputs(keys: readonly string[]): void;
  /** The retained entries, whose calls' outputs open with them. */
  setRetained(entryIds: readonly string[]): void;
  isRetained(entryId: string): boolean;
  subscribe(listener: () => void): () => void;
};
type OutputDisclosure = { open: boolean; fold(): void };
export function createOpenCalls(): OpenCalls {
  const open = new Set<string>(),
    outputs = new Map<string, { keys: readonly string[]; output: OutputDisclosure }>(),
    listeners = new Set<() => void>();
  let retained = new Set<string>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const outputsOf = (keys: readonly string[]) =>
    [...outputs.values()].filter((value) => value.keys.some((key) => keys.includes(key)));
  return {
    isOpen: (keys) => keys.some((key) => open.has(key)),
    set(keys, value) {
      let changed = false;
      for (const key of keys)
        if (open.has(key) !== value) {
          if (value) open.add(key);
          else open.delete(key);
          changed = true;
        }
      if (changed) notify();
    },
    setOutput(id, keys, output) {
      const previous = outputs.get(id);
      if (output) outputs.set(id, { keys, output });
      else outputs.delete(id);
      if (previous?.output.open !== output?.open || previous?.keys.join('\t') !== keys.join('\t'))
        notify();
    },
    isOutputOpen: (keys) => outputsOf(keys).some((value) => value.output.open),
    foldOutputs(keys) {
      for (const { output } of outputsOf(keys)) if (output.open) output.fold();
    },
    setRetained(entryIds) {
      if (entryIds.length === retained.size && entryIds.every((id) => retained.has(id))) return;
      retained = new Set(entryIds);
      notify();
    },
    isRetained: (entryId) => retained.has(entryId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export const OpenCallsContext = createContext<OpenCalls | null>(null);
