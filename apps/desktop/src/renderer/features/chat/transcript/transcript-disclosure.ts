import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ChatController } from '@moonbase/application/chat';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { getTranscriptDisclosureId } from '../../../../shared/transcript-source.ts';

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

/** Whether view memory holds a disclosure open; one whose ID can't be worked out shows open. */
const isRemembered = (expansion: string | null, failed: boolean, expandedIds: readonly string[]) =>
  failed || (expansion !== null && expandedIds.includes(expansion));

/** Writes one expansion into view memory. */
function setExpansion(controller: ChatController, expansion: string, open: boolean) {
  const { view } = controller.getSnapshot().transcript;
  if (view.expanded.includes(expansion) === open) return;
  controller.setTranscriptView({
    ...view,
    expanded: open ? [...view.expanded, expansion] : view.expanded.filter((id) => id !== expansion),
  });
}

/**
 * A fold remembered in view memory under a row and an ID, so it stays as the reader left it while
 * its rows are scrolled away and unmounted.
 */
export function useRememberedFold(
  entryId: string,
  id: string,
  expandedIds: readonly string[],
  controller: ChatController,
) {
  const { expansion, failed } = useExpansionId(entryId, id);
  return {
    open: isRemembered(expansion, failed, expandedIds),
    setOpen: (open: boolean) => {
      if (expansion) setExpansion(controller, expansion, open);
    },
  };
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
    open: isRemembered(expansion, failed, row.expandedIds),
    setOpen: (open: boolean) => {
      if (expansion) setExpansion(row.controller, expansion, open);
    },
  };
}

/**
 * The active Find match a reader folded a disclosure on. The fold lasts while that match is
 * active, and ends once no match is here or Find reveals the match again.
 */
export function useFoldedFindMatch(
  match: ChatTranscriptMatch | null,
  revealing: boolean,
  controller: ChatController,
) {
  const key = match ? JSON.stringify(match) : null;
  const [folded, setFolded] = useState<string | null>(null);
  if (folded !== null && (key === null || revealing)) setFolded(null);
  // A reveal into a folded run can start and end before it renders again, so the fold listens.
  useEffect(() => {
    if (folded === null) return;
    return controller.subscribe(() => {
      const { find } = controller.getSnapshot().transcript;
      if (find.revealing || !find.active || JSON.stringify(find.active) !== folded) setFolded(null);
    });
  }, [controller, folded]);
  return {
    /** The match holds the disclosure open. */
    holdsOpen: key !== null && folded !== key,
    /** Folds on the match: reader input, so it ends the reveal, which would open it again. */
    fold() {
      if (key === null) return;
      controller.cancelFindReveal();
      setFolded(key);
    },
  };
}

/**
 * A remembered disclosure: open when its view memory says so, and while the active Find match is
 * inside it unless the reader folded it for that match.
 */
export function useDisclosure({
  entryId,
  id,
  expandedIds,
  match,
  revealing,
  controller,
}: {
  entryId: string;
  id: string;
  /** View memory of expanded disclosure IDs. */
  expandedIds: readonly string[];
  /** The active Find match, when it is inside this disclosure. */
  match: ChatTranscriptMatch | null;
  /** Find is revealing the active match: it was just moved to, and no reader input ended that. */
  revealing: boolean;
  controller: ChatController;
}) {
  const { expansion, failed: disclosureError } = useExpansionId(entryId, id);
  const found = useFoldedFindMatch(match, revealing, controller);
  const open = isRemembered(expansion, disclosureError, expandedIds) || found.holdsOpen;
  const toggle = () => {
    if (!expansion) return;
    if (open) found.fold();
    setExpansion(controller, expansion, !open);
  };
  return {
    open,
    disclosureError,
    disabled: !expansion,
    onOpenChange: toggle,
  };
}

/**
 * Which tool calls are open. A call and its output are separate rows: the call's step publishes
 * whether it is open, and the output's step, which shows no line of its own while the call's entry
 * is retained, opens with it. An output open on its own (Find revealing a match in it) shows its
 * call open too, and folding the call folds it. Keys are `entryId\npartId` of the call.
 */
export type OpenCalls = {
  isOpen(key: string): boolean;
  set(key: string, open: boolean): void;
  /** Publishes an output step's own disclosure under its call's key; null when it unmounts. */
  setOutput(id: string, key: string, output: OutputDisclosure | null): void;
  isOutputOpen(key: string): boolean;
  foldOutputs(key: string): void;
  /** The retained entries, whose calls' outputs open with them. */
  setRetained(entryIds: readonly string[]): void;
  isRetained(entryId: string): boolean;
  subscribe(listener: () => void): () => void;
};
type OutputDisclosure = { open: boolean; fold(): void };
/** `retained` seeds the retained entries, so the first render already reads them. */
export function createOpenCalls(retained: readonly string[] = []): OpenCalls {
  const open = new Set<string>(),
    outputs = new Map<string, { key: string; output: OutputDisclosure }>(),
    listeners = new Set<() => void>();
  let retainedIds = new Set(retained);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const outputsOf = (key: string) => [...outputs.values()].filter((value) => value.key === key);
  return {
    isOpen: (key) => open.has(key),
    set(key, value) {
      if (open.has(key) === value) return;
      if (value) open.add(key);
      else open.delete(key);
      notify();
    },
    setOutput(id, key, output) {
      const previous = outputs.get(id);
      if (output) outputs.set(id, { key, output });
      else outputs.delete(id);
      if (previous?.output.open !== output?.open || previous?.key !== key) notify();
    },
    isOutputOpen: (key) => outputsOf(key).some((value) => value.output.open),
    foldOutputs(key) {
      for (const { output } of outputsOf(key)) if (output.open) output.fold();
    },
    setRetained(entryIds) {
      if (entryIds.length === retainedIds.size && entryIds.every((id) => retainedIds.has(id)))
        return;
      retainedIds = new Set(entryIds);
      notify();
    },
    isRetained: (entryId) => retainedIds.has(entryId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export const OpenCallsContext = createContext<OpenCalls | null>(null);

/** A store subscription for when there is nothing to subscribe to. */
export const noSubscription = () => () => {};

/**
 * Whether the transcript retains each call's entry, re-read as it retains or lets them go: a
 * retained call's output belongs to the call's step.
 */
export function useRetainedCalls(entryIds: readonly string[]) {
  const openCalls = useContext(OpenCallsContext);
  const retained = useSyncExternalStore(openCalls?.subscribe ?? noSubscription, () =>
    entryIds.filter((id) => openCalls?.isRetained(id) ?? true).join('\n'),
  );
  return useMemo(() => {
    const ids = new Set(retained.split('\n'));
    return (entryId: string) => ids.has(entryId);
  }, [retained]);
}
