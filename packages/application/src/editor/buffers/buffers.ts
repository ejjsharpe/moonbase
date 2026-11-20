import type { CommandInput, FileDocument, FileTarget } from '@moonbase/contracts/workspace';
import type { EditorTab } from '../recovery/recovery-layout.ts';
import { checkoutKey } from '../recovery/recovery-references.ts';
import { DraftMap, settleMap, shareEqual } from '../draft-map.ts';

export type PendingSave = CommandInput<'saveFile'>;
/** A file's text as the editor holds it: what is on disk, and the edits made over it. */
export type EditorBuffer = {
  /** This buffer's identity, which a move or rebind keeps. */
  id: string;
  target: FileTarget;
  text: string;
  disk: FileDocument;
  conflict?: FileDocument;
  pendingSave?: PendingSave;
  saving: boolean;
  /** Its file isn't on disk (text kept apart from a replaced file): a Save creates it. */
  newFile?: boolean;
};
/** The open buffers and their tabs in the recovery store, each by its file's key. */
export type BuffersState = {
  buffers: ReadonlyMap<string, EditorBuffer>;
  /** Every open tab's buffer in the recovery store. */
  tabs: ReadonlyMap<string, EditorTab>;
  /** Buffers this editor closed, which a late recovery outline may still list. */
  closed: ReadonlySet<string>;
};
/** A draft of the buffers whose maps, and each entry read from them, may be changed in place. */
export type BuffersDraft = {
  buffers: Map<string, EditorBuffer>;
  tabs: Map<string, EditorTab>;
  closed: Set<string>;
};
export const emptyBuffers: BuffersState = {
  buffers: new Map(),
  tabs: new Map(),
  closed: new Set(),
};

export const isDirty = (buffer: EditorBuffer) => buffer.text !== buffer.disk.text;
/** Whether a Save of the buffer is running or awaits its outcome. */
export const isSaving = (buffer: EditorBuffer) => buffer.saving || !!buffer.pendingSave;
/** Whether the buffer can follow the file on disk without losing edits. */
export const isClean = (buffer: EditorBuffer) => !isDirty(buffer) && !buffer.pendingSave;

/** A draft that copies only the buffers and tabs a change reads. */
export const draftBuffers = (state: BuffersState): BuffersDraft => ({
  buffers: new DraftMap(state.buffers, (buffer) => ({ ...buffer })),
  tabs: new DraftMap(state.tabs, (tab) => ({ ...tab })),
  closed: new Set(state.closed),
});
/** A changed draft as state again, keeping what it left as it was: `previous` when it changed nothing. */
export const settleBuffers = (previous: BuffersState, draft: BuffersDraft): BuffersState => {
  const next: BuffersState = {
    buffers: settleMap(draft.buffers),
    tabs: settleMap(draft.tabs),
    closed: shareEqual(previous.closed, draft.closed),
  };
  return next.buffers === previous.buffers &&
    next.tabs === previous.tabs &&
    next.closed === previous.closed
    ? previous
    : next;
};

/** What a tab or notice shows of a buffer: whether it has edits, and how its Save stands. */
export type BufferStatus = {
  dirty: boolean;
  saving: boolean;
  /** A Save whose outcome is unconfirmed. */
  pendingSave: boolean;
  /** The file changed on disk under the edits. */
  conflict: boolean;
};
export const toBufferStatus = (buffer: EditorBuffer): BufferStatus => ({
  dirty: isDirty(buffer),
  saving: buffer.saving,
  pendingSave: !!buffer.pendingSave,
  conflict: !!buffer.conflict,
});
/** The sorted paths of the buffers with edits in the checkout with this checkout key. */
export const listDirtyPaths = (state: BuffersState, checkout: string) =>
  [...state.buffers.values()]
    .filter((buffer) => checkoutKey(buffer.target.checkout) === checkout && isDirty(buffer))
    .map((buffer) => buffer.target.path)
    .sort();

export const findBufferById = (state: BuffersState, id: string) =>
  [...state.buffers].find(([, buffer]) => buffer.id === id);

export const newBuffer = (
  target: FileTarget,
  disk: FileDocument,
  text = disk.text,
): EditorBuffer => ({
  id: crypto.randomUUID(),
  target: structuredClone(target),
  text,
  disk: structuredClone(disk),
  saving: false,
});
