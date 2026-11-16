import type { CommandInput, FileDocument, FileTarget } from '@moonbase/contracts/workspace';
import type { EditorTab } from '../recovery/recovery-layout.ts';

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
/** A copy of the buffers whose maps and entries may be changed in place. */
export type BuffersDraft = {
  buffers: Map<string, EditorBuffer>;
  tabs: Map<string, EditorTab>;
  closed: Set<string>;
};
export const emptyBuffers: BuffersState = { buffers: new Map(), tabs: new Map(), closed: new Set() };

export const isDirty = (buffer: EditorBuffer) => buffer.text !== buffer.disk.text;
/** Whether a Save of the buffer is running or awaits its outcome. */
export const isSaving = (buffer: EditorBuffer) => buffer.saving || !!buffer.pendingSave;
/** Whether the buffer can follow the file on disk without losing edits. */
export const isClean = (buffer: EditorBuffer) => !isDirty(buffer) && !buffer.pendingSave;

export const draftBuffers = (state: BuffersState): BuffersDraft => ({
  buffers: new Map([...state.buffers].map(([key, buffer]) => [key, { ...buffer }])),
  tabs: new Map([...state.tabs].map(([key, tab]) => [key, { ...tab }])),
  closed: new Set(state.closed),
});

export const findBufferById = (state: BuffersState, id: string) =>
  [...state.buffers].find(([, buffer]) => buffer.id === id);

export const newBuffer = (target: FileTarget, disk: FileDocument, text = disk.text): EditorBuffer => ({
  id: crypto.randomUUID(),
  target: structuredClone(target),
  text,
  disk: structuredClone(disk),
  saving: false,
});
